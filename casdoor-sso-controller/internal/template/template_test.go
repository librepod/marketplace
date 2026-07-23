package template

import (
	"encoding/json"
	"testing"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"

	"github.com/librepod/casdoor-sso-controller/api/v1alpha1"
)

// jsonOverrides builds an apiextensionsv1.JSON from a Go map. Marshal of a sane
// map never errors; panic keeps the helper t-free so it works in any test style.
func jsonOverrides(m map[string]any) *apiextensionsv1.JSON {
	b, err := json.Marshal(m)
	if err != nil {
		panic(err)
	}
	return &apiextensionsv1.JSON{Raw: b}
}

func TestBuild_SetsCoreFieldsAndForcesSignUpFalse(t *testing.T) {
	app := Build(v1alpha1.SSOClientSpec{
		ClientID:      "headscale",
		Organization:  "librepod",
		RedirectUris:  []string{"https://h.example/cb"},
		Scopes:        []string{"openid"},
		GrantTypes:    []string{"authorization_code"},
		TokenFormat:   "JWT",
		ExpireInHours: 168,
	}, "secret-123")
	if app["name"] != "headscale" {
		t.Fatalf("name=%v", app["name"])
	}
	if app["organization"] != "librepod" {
		t.Fatalf("org=%v", app["organization"])
	}
	if app["clientId"] != "headscale" {
		t.Fatalf("clientId=%v", app["clientId"])
	}
	// displayName/title are self-labeled from the CR's clientId so every
	// provisioned app is identifiable in Casdoor instead of sharing a brand.
	if app["displayName"] != "headscale" || app["title"] != "headscale" {
		t.Fatalf("displayName/title=%v/%v, want headscale", app["displayName"], app["title"])
	}
	if app["clientSecret"] != "secret-123" {
		t.Fatalf("secret=%v", app["clientSecret"])
	}
	if app["enableSignUp"] != false {
		t.Fatalf("enableSignUp=%v", app["enableSignUp"])
	}
	uris, _ := app["redirectUris"].([]any)
	if len(uris) != 1 || uris[0] != "https://h.example/cb" {
		t.Fatalf("uris=%v", uris)
	}
	// Regression: scopes must NOT be overlaid from spec.Scopes. Casdoor's
	// Application.scopes is []object (ScopeItem); overlaying []string makes
	// add-application fail to unmarshal. The template's empty default is correct.
	if scopes, _ := app["scopes"].([]any); len(scopes) > 0 {
		t.Fatalf("scopes must not be overlaid from spec; got %v", scopes)
	}
	// The embed -> unmarshal -> overlay pipeline must preserve the ~70 template
	// fields Build does not touch, not just the ones it overlays.
	if len(app) < 50 {
		t.Fatalf("template fields dropped: map has only %d keys", len(app))
	}
}

// TestBuild_PreservesTemplateDefaultsWhenSpecOmits guards finding #2: a CR that
// omits grantTypes/tokenFormat/expireInHours must inherit the template's sane
// defaults, not get wiped to []/""/0 (grantTypes=[] would disable the auth-code
// flow). expireInHours is asserted as float64 because json.Unmarshal decodes
// numbers into float64 in a map[string]any.
func TestBuild_PreservesTemplateDefaultsWhenSpecOmits(t *testing.T) {
	// Minimal spec: no grantTypes, tokenFormat, or expireInHours.
	app := Build(v1alpha1.SSOClientSpec{
		ClientID:     "x",
		RedirectUris: []string{"https://x.example/cb"},
	}, "")
	if gt, _ := app["grantTypes"].([]any); len(gt) != 6 {
		t.Fatalf("grantTypes len=%d, want template default 6", len(gt))
	}
	if app["expireInHours"] != float64(168) {
		t.Fatalf("expireInHours=%v, want template default 168", app["expireInHours"])
	}
	if app["tokenFormat"] != "JWT" {
		t.Fatalf("tokenFormat=%v, want template default JWT", app["tokenFormat"])
	}
}

// TestBuild_AppliesApplicationOverrides guards the free-form override path: a
// CR sets branding fields the spec does not model (logo, a numeric formOffset,
// a nested themeData object) and Build shallow-merges them onto the Casdoor
// Application. This is what lets new Casdoor properties be configured per
// SSOClient without a CRD/controller release.
func TestBuild_AppliesApplicationOverrides(t *testing.T) {
	app := Build(v1alpha1.SSOClientSpec{
		ClientID:     "open-webui",
		RedirectUris: []string{"https://ow.example/cb"},
		ApplicationOverrides: jsonOverrides(map[string]any{
			"logo":       "https://openwebui.com/logo.png",
			"formOffset": 4,
			"themeData":  map[string]any{"primaryColor": "#fff"},
		}),
	}, "s")
	if app["logo"] != "https://openwebui.com/logo.png" {
		t.Fatalf("logo=%v", app["logo"])
	}
	// JSON decodes numbers into float64 in a map[string]any; the override is
	// stored verbatim, so formOffset is float64(4), not int(4).
	if app["formOffset"] != float64(4) {
		t.Fatalf("formOffset=%v, want float64(4)", app["formOffset"])
	}
	td, ok := app["themeData"].(map[string]any)
	if !ok || td["primaryColor"] != "#fff" {
		t.Fatalf("nested themeData not merged: %#v", app["themeData"])
	}
	// A nil override is a no-op: the template's baseline branding is untouched.
	app2 := Build(v1alpha1.SSOClientSpec{ClientID: "x", RedirectUris: []string{"https://x.example/cb"}}, "")
	if app2["logo"] != "" {
		t.Fatalf("nil overrides should leave template default, got logo=%v", app2["logo"])
	}
}

// TestBuild_OverridesCannotTouchManagedFields is the security boundary for the
// free-form field: every controller-managed key set via applicationOverrides is
// ignored, and the controller's own value (typed spec field or forced policy)
// wins. A CR must not be able to flip enableSignUp on, steal the app identity,
// override the secret, or desync redirectUris. Covers every key in
// casdoor.ManagedFields so a future addition cannot silently widen the hole.
func TestBuild_OverridesCannotTouchManagedFields(t *testing.T) {
	app := Build(v1alpha1.SSOClientSpec{
		ClientID:      "open-webui",
		Organization:  "librepod",
		RedirectUris:  []string{"https://ow.example/cb"},
		GrantTypes:    []string{"authorization_code"},
		TokenFormat:   "JWT",
		ExpireInHours: 168,
		ApplicationOverrides: jsonOverrides(map[string]any{
			"name":          "EVIL_NAME",
			"organization":  "evil-org",
			"clientId":      "EVIL_CLIENT",
			"clientSecret":  "EVIL_SECRET",
			"redirectUris":  []any{"https://evil/cb"},
			"grantTypes":    []any{"password"},
			"tokenFormat":   "EVIL_FMT",
			"expireInHours": 999,
			"enableSignUp":  true,
			"displayName":   "EVIL_DISPLAY",
			"title":         "EVIL_TITLE",
			// A non-managed field must still apply — proves the denylist skips
			// only managed keys, not everything.
			"logo": "https://x/l.png",
		}),
	}, "real-secret")

	if app["name"] != "open-webui" || app["clientId"] != "open-webui" {
		t.Fatalf("identity overridden: name=%v clientId=%v", app["name"], app["clientId"])
	}
	if app["organization"] != "librepod" {
		t.Fatalf("organization=%v, want librepod", app["organization"])
	}
	if app["clientSecret"] != "real-secret" {
		t.Fatalf("clientSecret=%v, want real-secret", app["clientSecret"])
	}
	if app["enableSignUp"] != false {
		t.Fatalf("enableSignUp=%v, want false — platform policy bypassed!", app["enableSignUp"])
	}
	if app["displayName"] != "open-webui" || app["title"] != "open-webui" {
		t.Fatalf("display/title overridden: %v/%v", app["displayName"], app["title"])
	}
	if gt, _ := app["grantTypes"].([]any); len(gt) != 1 || gt[0] != "authorization_code" {
		t.Fatalf("grantTypes=%v, want [authorization_code] from spec", app["grantTypes"])
	}
	if app["tokenFormat"] != "JWT" {
		t.Fatalf("tokenFormat=%v, want JWT from spec", app["tokenFormat"])
	}
	// When the spec sets ExpireInHours, Build assigns the Go int directly
	// (unlike the template-default path, which leaves JSON's float64). Either
	// way the override's 999 must be ignored and 168 win.
	if eh, ok := app["expireInHours"].(int); !ok || eh != 168 {
		t.Fatalf("expireInHours=%v, want int 168 from spec", app["expireInHours"])
	}
	if uris, _ := app["redirectUris"].([]any); len(uris) != 1 || uris[0] != "https://ow.example/cb" {
		t.Fatalf("redirectUris=%v, want spec value", app["redirectUris"])
	}
	if app["logo"] != "https://x/l.png" {
		t.Fatalf("non-managed logo should still apply, got %v", app["logo"])
	}
}
