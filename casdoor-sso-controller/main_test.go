package main

import "testing"

// TestValidateEnv_EmptyValuesFail guards finding #10: the controller must
// refuse to start (CrashLoop) when any Casdoor credential env var is empty,
// rather than silently running and backing off "Unauthorized operation" forever.
func TestValidateEnv_EmptyValuesFail(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
	}{
		{"missing base url", map[string]string{"CASDOOR_ACCESS_KEY": "k", "CASDOOR_ACCESS_SECRET": "s"}},
		{"missing key", map[string]string{"CASDOOR_BASE_URL": "u", "CASDOOR_ACCESS_SECRET": "s"}},
		{"missing secret", map[string]string{"CASDOOR_BASE_URL": "u", "CASDOOR_ACCESS_KEY": "k"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := validateEnv(func(k string) string { return c.env[k] }); err == nil {
				t.Fatal("expected error for empty credentials")
			}
		})
	}
}

func TestValidateEnv_AllPresentOK(t *testing.T) {
	env := map[string]string{"CASDOOR_BASE_URL": "u", "CASDOOR_ACCESS_KEY": "k", "CASDOOR_ACCESS_SECRET": "s"}
	if err := validateEnv(func(k string) string { return env[k] }); err != nil {
		t.Fatalf("unexpected err=%v", err)
	}
}
