// Package bootstrap provisions the controller's Casdoor M2M access key on
// first boot and reconciles it thereafter. It runs as a Deployment init
// container before the manager starts.
//
// Source of truth: the creds PVC file. The k8s Secret is a derived cache the
// manager reads via env; Casdoor holds the key the bootstrap created. On every
// boot, Secret <= PVC. Only when the PVC file is absent (first boot, or PVC
// lost) does the bootstrap contact Casdoor to mint a fresh key.
package bootstrap

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
)

const managedLabelKey = "marketplace.librepod.org/sso-managed"

// Credentials are the Casdoor M2M access key. Persisted as JSON on the creds
// PVC (durable) and mirrored into the k8s Secret the manager reads.
type Credentials struct {
	AccessKey    string `json:"accessKey"`
	AccessSecret string `json:"accessSecret"`
}

// CasdoorMinter logs in and creates/deletes the controller's access key.
// Implemented by *casdoor.SessionClient; faked in tests.
type CasdoorMinter interface {
	Login(ctx context.Context, adminPassword string) error
	CreateAccessKey(ctx context.Context, name, accessKey, accessSecret string) error
	DeleteAccessKey(ctx context.Context, name string) error
}

// Deps are the bootstrap's injected dependencies.
type Deps struct {
	Casdoor       CasdoorMinter
	K8s           client.Client
	CredsFile     string // PVC-mounted file path
	SecretName    string
	SecretNS      string
	KeyName       string // Casdoor key name, e.g. librepod-sso-controller
	AdminPassword string
	// KeyGen overrides the credential generator (test seam). Nil => random UUIDs.
	KeyGen func() (accessKey, accessSecret string, err error)
}

// Run is idempotent. PVC file present -> materialize Secret from it (no Casdoor
// calls). PVC file absent -> login, mint a key with client-supplied creds, write
// the PVC file, then the Secret. On a name conflict it deletes the stale key
// and retries once.
func Run(ctx context.Context, d Deps) error {
	if creds, ok := readCreds(d.CredsFile); ok {
		return ensureSecret(ctx, d, creds)
	}

	ak, as, err := d.genKey()
	if err != nil {
		return fmt.Errorf("generate credential: %w", err)
	}
	if err := d.Casdoor.Login(ctx, d.AdminPassword); err != nil {
		return fmt.Errorf("casdoor login: %w", err)
	}
	if err := d.Casdoor.CreateAccessKey(ctx, d.KeyName, ak, as); err != nil {
		// Stale same-name key (PVC lost but Casdoor survived): delete + retry.
		if delErr := d.Casdoor.DeleteAccessKey(ctx, d.KeyName); delErr != nil {
			return fmt.Errorf("create access key: %w (stale-key delete also failed: %v)", err, delErr)
		}
		ak, as, err = d.genKey()
		if err != nil {
			return fmt.Errorf("regenerate credential: %w", err)
		}
		if err := d.Casdoor.CreateAccessKey(ctx, d.KeyName, ak, as); err != nil {
			return fmt.Errorf("create access key after stale delete: %w", err)
		}
	}

	creds := Credentials{AccessKey: ak, AccessSecret: as}
	if err := writeCreds(d.CredsFile, creds); err != nil {
		return fmt.Errorf("write creds file: %w", err)
	}
	return ensureSecret(ctx, d, creds)
}

func (d Deps) genKey() (string, string, error) {
	if d.KeyGen != nil {
		return d.KeyGen()
	}
	ak, err := newUUID()
	if err != nil {
		return "", "", err
	}
	as, err := newUUID()
	if err != nil {
		return "", "", err
	}
	return ak, as, nil
}

// readCreds returns the stored credentials and true, or false if the file is
// absent/unreadable/incomplete (all treated as "must mint").
func readCreds(path string) (Credentials, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Credentials{}, false
	}
	var c Credentials
	if err := json.Unmarshal(b, &c); err != nil {
		return Credentials{}, false
	}
	if c.AccessKey == "" || c.AccessSecret == "" {
		return Credentials{}, false
	}
	return c, true
}

func writeCreds(path string, c Credentials) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600) // holds a secret -> 0600
}

// ensureSecret creates or updates the k8s Secret to match the creds. No-op if
// already correct. Uses Data (not StringData) so reads are unambiguous.
func ensureSecret(ctx context.Context, d Deps, c Credentials) error {
	sec := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: d.SecretName, Namespace: d.SecretNS}}
	_, err := controllerutil.CreateOrUpdate(ctx, d.K8s, sec, func() error {
		if sec.Labels == nil {
			sec.Labels = map[string]string{}
		}
		sec.Labels[managedLabelKey] = "true"
		sec.Type = corev1.SecretTypeOpaque
		sec.Data = map[string][]byte{
			"accessKey":    []byte(c.AccessKey),
			"accessSecret": []byte(c.AccessSecret),
		}
		return nil
	})
	return err
}

// newUUID returns a random RFC-4122 v4 UUID string. crypto/rand failure is
// surfaced by the caller (a credential must never be silently weak).
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
