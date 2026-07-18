package naming

import (
	"testing"

	"github.com/librepod/casdoor-sso-controller/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestResolveRedirects_ExpandsBaseDomain(t *testing.T) {
	got := ResolveRedirects([]string{"https://h.${BASE_DOMAIN}/cb", "https://h.${BASE_DOMAIN}"}, "libre.pod")
	want := []string{"https://h.libre.pod/cb", "https://h.libre.pod"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("i=%d got=%s want=%s", i, got[i], want[i])
		}
	}
}

func TestDefaults(t *testing.T) {
	cr := &v1alpha1.SSOClient{ObjectMeta: metav1.ObjectMeta{Name: "x-sso", Namespace: "ns"}}
	if SecretName(cr) != "x-sso" {
		t.Fatalf("SecretName=%s", SecretName(cr))
	}
	if SecretNamespace(cr, "ns") != "ns" {
		t.Fatalf("SecretNamespace=%s", SecretNamespace(cr, "ns"))
	}
	k := DefaultKeys()
	if k.ClientID != "OIDC_CLIENT_ID" || k.ClientSecret != "OIDC_CLIENT_SECRET" || k.Issuer != "OIDC_ISSUER" {
		t.Fatalf("keys=%+v", k)
	}
}

func TestIssuerURL_IsDiscoveryEndpoint(t *testing.T) {
	got := IssuerURL("libre.pod")
	want := "https://sso.libre.pod/.well-known/openid-configuration"
	if got != want {
		t.Fatalf("IssuerURL=%q want %q", got, want)
	}
}
