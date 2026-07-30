package bootstrap

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

type sentinelErr string

func (s sentinelErr) Error() string { return string(s) }
func errSentinel() error            { return sentinelErr("boom") }

type fakeMinter struct {
	loginErr   error
	createErrs []error // one per CreateAccessKey call, in order
	deleteErr  error
	Deletes    int
}

func (f *fakeMinter) Login(context.Context, string) error { return f.loginErr }
func (f *fakeMinter) CreateAccessKey(context.Context, string, string, string) error {
	if len(f.createErrs) == 0 {
		return nil
	}
	err := f.createErrs[0]
	f.createErrs = f.createErrs[1:]
	return err
}
func (f *fakeMinter) DeleteAccessKey(context.Context, string) error {
	f.Deletes++
	return f.deleteErr
}

func newScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	return s
}

func newDeps(t *testing.T, m CasdoorMinter) Deps {
	t.Helper()
	return Deps{
		Casdoor:       m,
		K8s:           fake.NewClientBuilder().WithScheme(newScheme(t)).Build(),
		CredsFile:     filepath.Join(t.TempDir(), "creds", "credentials.json"),
		SecretName:    "casdoor-api-credentials",
		SecretNS:      "casdoor-sso-controller",
		KeyName:       "librepod-sso-controller",
		AdminPassword: "123",
		KeyGen:        func() (string, string, error) { return "ak", "as", nil },
	}
}

func secretData(t *testing.T, d Deps) map[string]string {
	t.Helper()
	sec := &corev1.Secret{}
	err := d.K8s.Get(context.Background(), types.NamespacedName{Name: d.SecretName, Namespace: d.SecretNS}, sec)
	if err != nil {
		t.Fatalf("get secret: %v", err)
	}
	return map[string]string{
		"accessKey":    string(sec.Data["accessKey"]),
		"accessSecret": string(sec.Data["accessSecret"]),
	}
}

// TestRun_PVCPresent_MaterializesSecret_NoCasdoor: the steady-state path. PVC
// holds the credential, so the Secret is written from it and Casdoor is never
// contacted.
func TestRun_PVCPresent_MaterializesSecret_NoCasdoor(t *testing.T) {
	m := &fakeMinter{}
	d := newDeps(t, m)
	if err := os.MkdirAll(filepath.Dir(d.CredsFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(d.CredsFile, []byte(`{"accessKey":"pvck","accessSecret":"pvcs"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Run(context.Background(), d); err != nil {
		t.Fatalf("run: %v", err)
	}
	got := secretData(t, d)
	if got["accessKey"] != "pvck" || got["accessSecret"] != "pvcs" {
		t.Fatalf("secret=%v, want creds from PVC", got)
	}
}

// TestRun_PVCAbsent_MintsKey_WritesPVCAndSecret: the first-boot path.
func TestRun_PVCAbsent_MintsKey_WritesPVCAndSecret(t *testing.T) {
	m := &fakeMinter{}
	d := newDeps(t, m)
	if err := Run(context.Background(), d); err != nil {
		t.Fatalf("run: %v", err)
	}
	if m.Deletes != 0 {
		t.Fatalf("unexpected delete calls=%d", m.Deletes)
	}
	got := secretData(t, d)
	if got["accessKey"] != "ak" || got["accessSecret"] != "as" {
		t.Fatalf("secret=%v, want generated ak/as", got)
	}
	// PVC file now persists the credential (steady-state on next boot).
	b, err := os.ReadFile(d.CredsFile)
	if err != nil {
		t.Fatalf("creds file not written: %v", err)
	}
	if string(b) != `{"accessKey":"ak","accessSecret":"as"}` {
		t.Fatalf("creds file=%s", b)
	}
}

func TestRun_LoginFailure_NoWrites(t *testing.T) {
	m := &fakeMinter{loginErr: errSentinel()}
	d := newDeps(t, m)
	if err := Run(context.Background(), d); err == nil {
		t.Fatal("expected error on login failure")
	}
	// No PVC file, no Secret written.
	if _, err := os.Stat(d.CredsFile); !os.IsNotExist(err) {
		t.Fatal("creds file should not exist after login failure")
	}
	sec := &corev1.Secret{}
	err := d.K8s.Get(context.Background(), types.NamespacedName{Name: d.SecretName, Namespace: d.SecretNS}, sec)
	if err == nil || !apierrors.IsNotFound(err) {
		t.Fatalf("secret should not exist; got err=%v", err)
	}
}

// TestRun_CreateConflict_DeletesStaleAndRetries: when add-key fails (stale
// same-name key), Run deletes the stale key and retries once with fresh creds.
func TestRun_CreateConflict_DeletesStaleAndRetries(t *testing.T) {
	m := &fakeMinter{createErrs: []error{errSentinel()}} // first add-key fails, second ok
	d := newDeps(t, m)
	if err := Run(context.Background(), d); err != nil {
		t.Fatalf("run: %v", err)
	}
	if m.Deletes != 1 {
		t.Fatalf("delete calls=%d, want 1", m.Deletes)
	}
	got := secretData(t, d)
	if got["accessKey"] != "ak" {
		t.Fatalf("secret=%v after retry", got)
	}
}

// TestRun_CreateConflict_DeleteAlsoFails_ReturnsError.
func TestRun_CreateConflict_DeleteAlsoFails_ReturnsError(t *testing.T) {
	m := &fakeMinter{createErrs: []error{errSentinel()}, deleteErr: errSentinel()}
	d := newDeps(t, m)
	if err := Run(context.Background(), d); err == nil {
		t.Fatal("expected error when create and delete both fail")
	}
}

// TestRun_CreateConflict_SecondCreateAlsoFails_ReturnsError: the retry-create
// branch (Run's second CreateAccessKey). Both creates fail, so Run must error,
// attempt exactly one delete, and leave no creds file behind.
func TestRun_CreateConflict_SecondCreateAlsoFails_ReturnsError(t *testing.T) {
	m := &fakeMinter{createErrs: []error{errSentinel(), errSentinel()}} // both creates fail
	d := newDeps(t, m)
	if err := Run(context.Background(), d); err == nil {
		t.Fatal("expected error when both creates fail")
	}
	if m.Deletes != 1 {
		t.Fatalf("delete calls=%d, want 1", m.Deletes)
	}
	if _, err := os.Stat(d.CredsFile); !os.IsNotExist(err) {
		t.Fatal("creds file should not exist when retry create failed")
	}
}
