package main

import (
	"context"
	"fmt"
	"os"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	_ "k8s.io/client-go/plugin/pkg/client/auth"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/metrics/server"

	marketplacev1alpha1 "github.com/librepod/casdoor-sso-controller/api/v1alpha1"
	"github.com/librepod/casdoor-sso-controller/internal/bootstrap"
	"github.com/librepod/casdoor-sso-controller/internal/casdoor"
	"github.com/librepod/casdoor-sso-controller/internal/controller"
)

var scheme = runtime.NewScheme()

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(marketplacev1alpha1.AddToScheme(scheme))
	utilruntime.Must(corev1.AddToScheme(scheme))
}

func main() {
	// Initialize the logger first: controller-runtime defaults to a discard
	// logger, so without this every setupLog/reconcile log would be a no-op.
	ctrl.SetLogger(zap.New())

	// Bootstrap subcommand: provision the Casdoor access key before the manager
	// starts (runs as a Deployment init container). Dispatch BEFORE validateEnv
	// — the whole point is that no access key exists yet.
	if len(os.Args) > 1 && os.Args[1] == "bootstrap" {
		if err := bootstrap.Run(context.Background(), bootstrapDeps()); err != nil {
			fmt.Fprintln(os.Stderr, "bootstrap failed:", err)
			os.Exit(1)
		}
		return
	}

	// Fail fast on missing Casdoor credentials: a manager that starts without
	// them can only back off "Unauthorized operation" forever. CrashLoop here so
	// the missing Secret (casdoor-api-credentials) is obvious from the pod status.
	if err := validateEnv(os.Getenv); err != nil {
		setupLog(err, "invalid Casdoor configuration; refusing to start")
		os.Exit(1)
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:           scheme,
		Metrics:          server.Options{BindAddress: "0"},
		LeaderElection:   true,
		LeaderElectionID: "casdoor-sso-controller.marketplace.librepod.org",
	})
	if err != nil {
		setupLog(err, "unable to start manager")
		os.Exit(1)
	}

	baseDomain := os.Getenv("BASE_DOMAIN")
	org := os.Getenv("CASDOOR_ORG")
	if org == "" {
		org = "librepod"
	}

	casdoorClient := buildCasdoorClient()

	if err := (&controller.SSOClientReconciler{
		Client:     mgr.GetClient(),
		Scheme:     mgr.GetScheme(),
		Casdoor:    casdoorClient,
		BaseDomain: baseDomain,
		Org:        org,
	}).SetupWithManager(mgr); err != nil {
		setupLog(err, "unable to register reconciler")
		os.Exit(1)
	}

	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog(err, "manager stopped")
		os.Exit(1)
	}
}

// buildCasdoorClient constructs the Casdoor client using an M2M Access Key
// (accessKey/accessSecret) read from the environment. The Deployment injects
// them from the casdoor-api-credentials Secret via secretKeyRef. The key must be
// User=admin scoped (application management is admin-only on Casdoor 3.x).
// Empty values yield "Unauthorized operation", which the reconciler backs off
// and retries.
func buildCasdoorClient() casdoor.Client {
	return casdoor.New(casdoor.Config{
		BaseURL:      os.Getenv("CASDOOR_BASE_URL"),
		AccessKey:    os.Getenv("CASDOOR_ACCESS_KEY"),
		AccessSecret: os.Getenv("CASDOOR_ACCESS_SECRET"),
	})
}

// validateEnv rejects an empty Casdoor base URL, access key, or access secret.
// Each is injected from Secret/casdoor-api-credentials (or CASDOOR_BASE_URL)
// via secretKeyRef/env; an empty value means the Secret is missing or mis-keyed,
// and the controller cannot function. get is os.Getenv in production and a map
// lookup in tests.
func validateEnv(get func(string) string) error {
	missing := func(name string) error {
		return fmt.Errorf("%s is empty — populate Secret/casdoor-api-credentials (keys accessKey/accessSecret) and CASDOOR_BASE_URL", name)
	}
	if get("CASDOOR_BASE_URL") == "" {
		return missing("CASDOOR_BASE_URL")
	}
	if get("CASDOOR_ACCESS_KEY") == "" {
		return missing("CASDOOR_ACCESS_KEY")
	}
	if get("CASDOOR_ACCESS_SECRET") == "" {
		return missing("CASDOOR_ACCESS_SECRET")
	}
	return nil
}

func setupLog(err error, msg string) {
	ctrl.Log.Error(err, msg)
}

// bootstrapDeps assembles the bootstrap's dependencies from env. The init
// container sets CASDOOR_BASE_URL, CASDOOR_ADMIN_PASSWORD (default "123"),
// CREDS_FILE, KEY_NAME, SECRET_NAMESPACE; everything else has a sane default.
func bootstrapDeps() bootstrap.Deps {
	ns := os.Getenv("SECRET_NAMESPACE")
	if ns == "" {
		ns = "casdoor-sso-controller"
	}
	credsFile := os.Getenv("CREDS_FILE")
	if credsFile == "" {
		credsFile = "/creds/credentials.json"
	}
	keyName := os.Getenv("KEY_NAME")
	if keyName == "" {
		keyName = "librepod-sso-controller"
	}
	pw := os.Getenv("CASDOOR_ADMIN_PASSWORD")
	if pw == "" {
		pw = "123"
	}
	return bootstrap.Deps{
		Casdoor:       casdoor.NewSessionClient(os.Getenv("CASDOOR_BASE_URL"), 0),
		K8s:           newK8sClient(),
		CredsFile:     credsFile,
		SecretName:    "casdoor-api-credentials",
		SecretNS:      ns,
		KeyName:       keyName,
		AdminPassword: pw,
	}
}

// newK8sClient builds a controller-runtime client from the in-cluster rest
// config, for writing Secret/casdoor-api-credentials.
func newK8sClient() client.Client {
	s := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(s))
	c, err := client.New(ctrl.GetConfigOrDie(), client.Options{Scheme: s})
	if err != nil {
		fmt.Fprintln(os.Stderr, "build k8s client:", err)
		os.Exit(1)
	}
	return c
}
