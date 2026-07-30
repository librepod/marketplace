package template

import (
	_ "embed"
	"encoding/json"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"

	"github.com/librepod/casdoor-sso-controller/api/v1alpha1"
	"github.com/librepod/casdoor-sso-controller/internal/casdoor"
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
	// Apply free-form overrides BEFORE any managed-field stamp so the stamps
	// below always win. applyOverrides additionally skips managed keys
	// (casdoor.ManagedFields), so this is belt-and-suspenders: a CR cannot
	// bypass platform policy or desync identity via an override even if a
	// future edit reorders the stamps.
	applyOverrides(app, spec.ApplicationOverrides)
	app[casdoor.FieldName] = spec.ClientID
	app[casdoor.FieldOrganization] = spec.Organization
	app[casdoor.FieldClientID] = spec.ClientID
	// displayName/title are not CR-controlled yet; default them to the app's
	// identity so every provisioned app is self-labeled in Casdoor instead of
	// sharing a hardcoded brand string.
	app[casdoor.FieldDisplayName] = spec.ClientID
	app[casdoor.FieldTitle] = spec.ClientID
	app[casdoor.FieldClientSecret] = clientSecret
	app[casdoor.FieldRedirectUris] = toAnySlice(spec.RedirectUris)
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
		app[casdoor.FieldGrantTypes] = toAnySlice(spec.GrantTypes)
	}
	if spec.TokenFormat != "" {
		app[casdoor.FieldTokenFormat] = spec.TokenFormat
	}
	if spec.ExpireInHours > 0 {
		app[casdoor.FieldExpireHours] = spec.ExpireInHours
	}
	app[casdoor.FieldEnableSignUp] = false // platform policy: sign-in only
	return app
}

// applyOverrides shallow-merges spec.ApplicationOverrides onto app, skipping
// controller-managed keys (casdoor.ManagedFields). A nil/empty override is a
// no-op. Invalid JSON cannot occur for an apiextensionsv1.JSON that passed CRD
// admission, but is defended anyway so a corrupt value never silently zeros the
// app — it is dropped, and the missing field surfaces as drift/Casdoor error.
func applyOverrides(app map[string]any, overrides *apiextensionsv1.JSON) {
	if overrides == nil || len(overrides.Raw) == 0 {
		return
	}
	var m map[string]any
	if err := json.Unmarshal(overrides.Raw, &m); err != nil {
		return
	}
	for k, v := range m {
		if _, managed := casdoor.ManagedFields[k]; managed {
			continue
		}
		app[k] = v
	}
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
