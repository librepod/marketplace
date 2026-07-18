package controller

import (
	"testing"

	"github.com/librepod/casdoor-sso-controller/internal/casdoor"
)

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
