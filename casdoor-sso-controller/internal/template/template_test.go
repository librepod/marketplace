package template

import (
	"testing"

	"github.com/librepod/casdoor-sso-controller/api/v1alpha1"
)

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
