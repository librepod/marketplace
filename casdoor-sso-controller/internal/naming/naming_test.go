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
	tests := []struct {
		name       string
		baseDomain string
		subdomain  string
		want       string
	}{
		{name: "empty subdomain defaults to id", baseDomain: "libre.pod", subdomain: "", want: "https://id.libre.pod/.well-known/openid-configuration"},
		{name: "explicit id", baseDomain: "libre.pod", subdomain: "id", want: "https://id.libre.pod/.well-known/openid-configuration"},
		{name: "custom subdomain", baseDomain: "libre.pod", subdomain: "auth", want: "https://auth.libre.pod/.well-known/openid-configuration"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := IssuerURL(tc.baseDomain, tc.subdomain)
			if got != tc.want {
				t.Fatalf("IssuerURL(%q,%q)=%q want %q", tc.baseDomain, tc.subdomain, got, tc.want)
			}
		})
	}
}
