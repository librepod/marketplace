package naming

import (
	"strings"

	"github.com/librepod/casdoor-sso-controller/api/v1alpha1"
)

const baseDomainVar = "${BASE_DOMAIN}"

// ResolveRedirects expands ${BASE_DOMAIN} in each URI.
func ResolveRedirects(uris []string, baseDomain string) []string {
	out := make([]string, 0, len(uris))
	for _, u := range uris {
		out = append(out, strings.ReplaceAll(u, baseDomainVar, baseDomain))
	}
	return out
}

func SecretName(cr *v1alpha1.SSOClient) string {
	if cr.Spec.Output.SecretName != "" {
		return cr.Spec.Output.SecretName
	}
	return cr.Name
}

func SecretNamespace(cr *v1alpha1.SSOClient, fallback string) string {
	if cr.Spec.Output.SecretNamespace != "" {
		return cr.Spec.Output.SecretNamespace
	}
	if cr.Namespace != "" {
		return cr.Namespace
	}
	return fallback
}

func Keys(cr *v1alpha1.SSOClient) v1alpha1.SSOClientKeys {
	k := cr.Spec.Output.Keys
	if k.ClientID == "" {
		k.ClientID = "OIDC_CLIENT_ID"
	}
	if k.ClientSecret == "" {
		k.ClientSecret = "OIDC_CLIENT_SECRET"
	}
	if k.Issuer == "" {
		k.Issuer = "OIDC_ISSUER"
	}
	return k
}

// DefaultKeys is a convenience for tests.
func DefaultKeys() v1alpha1.SSOClientKeys {
	return Keys(&v1alpha1.SSOClient{})
}

// IssuerURL builds the OIDC discovery URL from BASE_DOMAIN. Most OIDC clients
// expect the full well-known endpoint, not the bare issuer, so they can fetch
// /.well-known/openid-configuration.
func IssuerURL(baseDomain string) string {
	return "https://sso." + baseDomain + "/.well-known/openid-configuration"
}
