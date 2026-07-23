package controller

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"testing"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"

	"github.com/librepod/casdoor-sso-controller/internal/casdoor"
)

// overridesJSON builds an apiextensionsv1.JSON from a Go map, for tests in this
// package (both testing.T and Ginkgo styles). Marshal of a sane map never errors.
func overridesJSON(m map[string]any) *apiextensionsv1.JSON {
	b, err := json.Marshal(m)
	if err != nil {
		panic(fmt.Sprintf("overridesJSON marshal: %v", err))
	}
	return &apiextensionsv1.JSON{Raw: b}
}

// TestNewClientSecret_NonEmptyHex guards finding #4: the rotation secret is a
// 20-byte random value rendered as 40 hex characters, and crypto/rand failures
// are surfaced as errors (not silently swallowed into a short/empty secret).
func TestNewClientSecret_NonEmptyHex(t *testing.T) {
	s, err := newClientSecret()
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if len(s) != 40 {
		t.Fatalf("len=%d want 40", len(s))
	}
}

// TestDriftFieldsAreCasdoorConstants guards finding #9: every field drift()
// reconciles must be one of the exported casdoor field constants, never a
// free-floating string literal (which could silently typo out of sync).
func TestDriftFieldsAreCasdoorConstants(t *testing.T) {
	for _, k := range append(append([]string{}, driftSliceFields...), driftScalarFields...) {
		switch k {
		case casdoor.FieldRedirectUris, casdoor.FieldGrantTypes, casdoor.FieldTokenFormat,
			casdoor.FieldExpireHours, casdoor.FieldOrganization, casdoor.FieldEnableSignUp:
		default:
			t.Fatalf("drift key %q is not a casdoor field constant", k)
		}
	}
}

// TestEqualStringSet_OrderInsensitive guards finding #15: drift on slice fields
// (redirectUris, grantTypes) must be order-insensitive so a Casdoor response
// that reorders the same set does not hot-loop UpdateApplication every reconcile.
func TestEqualStringSet_OrderInsensitive(t *testing.T) {
	if !equalStringSet([]string{"a", "b"}, []string{"b", "a"}) {
		t.Fatal("order mismatch should be equal")
	}
	if equalStringSet([]string{"a", "a"}, []string{"a"}) {
		t.Fatal("duplicate count must be distinguished")
	}
	if !equalStringSet(nil, []string{}) {
		t.Fatal("nil vs empty should be equal")
	}
}

// TestOverrideKeys_ExcludesManagedFields guards the drift key set: overrideKeys
// returns only the NON-managed applicationOverrides keys so drift reconciles
// branding fields (logo, formOffset) without re-comparing controller-owned
// fields that the typed path already owns. Managed keys in the override are
// silently dropped here too (defense in depth with template.applyOverrides).
func TestOverrideKeys_ExcludesManagedFields(t *testing.T) {
	j := overridesJSON(map[string]any{
		"logo":         "x",
		"formOffset":   2,
		"enableSignUp": true, // managed -> dropped
		"clientId":     "y",  // managed -> dropped
	})
	got := overrideKeys(j)
	sort.Strings(got)
	want := []string{"formOffset", "logo"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("overrideKeys=%v, want %v", got, want)
	}
}

// TestOverrideKeys_NilSafe guards that a missing/empty/corrupt override never
// panics and yields no keys — so a CR without applicationOverrides (the common
// case) costs drift() nothing.
func TestOverrideKeys_NilSafe(t *testing.T) {
	if overrideKeys(nil) != nil {
		t.Fatal("nil JSON should yield nil")
	}
	if overrideKeys(&apiextensionsv1.JSON{Raw: nil}) != nil {
		t.Fatal("nil Raw should yield nil")
	}
	if overrideKeys(&apiextensionsv1.JSON{Raw: []byte("not-json")}) != nil {
		t.Fatal("invalid JSON should yield nil, not panic")
	}
}

// TestOverrideEqual guards the override comparison: scalars route through
// scalarEqual (so absent/nil == zero value and an empty branding string does
// NOT hot-loop against Casdoor's empty-string response), while nested objects
// and arrays compare structurally.
func TestOverrideEqual(t *testing.T) {
	cases := []struct {
		name string
		a, b any
		want bool
	}{
		{"scalar equal", "x", "x", true},
		{"nil vs empty string (no hot-loop)", nil, "", true},
		{"empty string vs nil", "", nil, true},
		{"scalar drift", "a", "b", false},
		{"number equal", float64(4), float64(4), true},
		{"number drift", float64(4), float64(2), false},
		{"nested map equal", map[string]any{"a": float64(1)}, map[string]any{"a": float64(1)}, true},
		{"nested map drift", map[string]any{"a": float64(1)}, map[string]any{"a": float64(2)}, false},
		{"slice equal", []any{"a"}, []any{"a"}, true},
		{"slice drift", []any{"a"}, []any{"b"}, false},
	}
	for _, c := range cases {
		if got := overrideEqual(c.a, c.b); got != c.want {
			t.Fatalf("%s: overrideEqual(%#v, %#v)=%v, want %v", c.name, c.a, c.b, got, c.want)
		}
	}
}
