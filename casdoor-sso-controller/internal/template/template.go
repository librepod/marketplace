package template

import (
	_ "embed"
	"encoding/json"

	"github.com/librepod/casdoor-sso-controller/api/v1alpha1"
)

//go:embed application-template.json
var templateJSON []byte

// init fails fast at startup if the embedded template is not valid JSON. The
// asset is compile-time fixed, so a parse error can never be recovered at
// runtime — better to crashloop than to silently provision near-empty apps.
func init() {
	if !json.Valid(templateJSON) {
		panic("casdoor-sso-controller: embedded application-template.json is invalid JSON")
	}
}

// Build returns a Casdoor Application map: the embedded baseline application
// template overlaid with the CR's fields. enableSignUp is forced false.
// clientSecret is set (used on create; ignored on update-preserve).
func Build(spec v1alpha1.SSOClientSpec, clientSecret string) map[string]any {
	var app map[string]any
	_ = json.Unmarshal(templateJSON, &app)
	if app == nil {
		app = map[string]any{}
	}
	app["name"] = spec.ClientID
	app["organization"] = spec.Organization
	app["clientId"] = spec.ClientID
	// displayName/title are not CR-controlled yet; default them to the app's
	// identity so every provisioned app is self-labeled in Casdoor instead of
	// sharing a hardcoded brand string.
	app["displayName"] = spec.ClientID
	app["title"] = spec.ClientID
	app["clientSecret"] = clientSecret
	app["redirectUris"] = toAnySlice(spec.RedirectUris)
	// scopes is intentionally NOT overlaid from spec.Scopes: Casdoor's
	// Application.scopes is []object (ScopeItem), and every working app
	// (e.g. app-built-in) uses scopes:[]. Overlaying []string makes
	// add-application fail ("cannot unmarshal string into ScopeItem"). OIDC
	// scopes are driven by the client's auth request, not this field.
	// grantTypes/tokenFormat/expireInHours are overlaid ONLY when the CR sets
	// them, so a CR that omits them inherits the template's proven defaults
	// (6 grant types incl. authorization_code, JWT, 168h) instead of wiping
	// them to []/""/0 — grantTypes=[] would silently disable the auth-code flow.
	if len(spec.GrantTypes) > 0 {
		app["grantTypes"] = toAnySlice(spec.GrantTypes)
	}
	if spec.TokenFormat != "" {
		app["tokenFormat"] = spec.TokenFormat
	}
	if spec.ExpireInHours > 0 {
		app["expireInHours"] = spec.ExpireInHours
	}
	app["enableSignUp"] = false // platform policy: sign-in only
	return app
}

// toAnySlice converts a []string to []any so the resulting map round-trips
// correctly: json.Unmarshal yields []any for arrays, and downstream code
// (casdoor.AppRedirectUris, the drift comparator) type-asserts []any.
// Assigning a []string directly would make those assertions fail silently.
func toAnySlice(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}
