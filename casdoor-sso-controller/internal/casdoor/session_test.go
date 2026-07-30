package casdoor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestSessionClient_LoginStoresCookie asserts Login persists the session cookie
// on the client's jar so the subsequent CreateAccessKey call is authenticated,
// and that the client-supplied accessKey/accessSecret + state=Active are sent.
func TestSessionClient_LoginStoresCookie(t *testing.T) {
	var sawCookieOnAddKey bool
	var addBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/login":
			http.SetCookie(w, &http.Cookie{Name: "casdoor_session_id", Value: "abc"})
			_ = json.NewEncoder(w).Encode(apiResp{Status: "ok", Data: json.RawMessage(`"built-in/admin"`)})
		case "/api/add-key":
			sawCookieOnAddKey = r.Header.Get("Cookie") != ""
			_ = json.NewDecoder(r.Body).Decode(&addBody)
			_ = json.NewEncoder(w).Encode(apiResp{Status: "ok", Data: json.RawMessage(`"Affected"`)})
		}
	}))
	t.Cleanup(srv.Close)

	c := NewSessionClient(srv.URL, 0)
	if err := c.Login(context.Background(), "123"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if err := c.CreateAccessKey(context.Background(), "n", "k", "s"); err != nil {
		t.Fatalf("add-key: %v", err)
	}
	if !sawCookieOnAddKey {
		t.Fatal("add-key was sent without the login cookie")
	}
	if addBody["accessKey"] != "k" || addBody["accessSecret"] != "s" {
		t.Fatalf("client-supplied creds not sent: %v", addBody)
	}
	if addBody["state"] != "Active" {
		t.Fatalf("state=%v, want Active (inactive keys fail auth)", addBody["state"])
	}
	if addBody["user"] != "admin" || addBody["type"] != "User" {
		t.Fatalf("key scope wrong: %v", addBody)
	}
}

func TestSessionClient_LoginError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(apiResp{Status: "error", Msg: "bad password"})
	}))
	t.Cleanup(srv.Close)
	c := NewSessionClient(srv.URL, 0)
	if err := c.Login(context.Background(), "wrong"); err == nil {
		t.Fatal("expected login error for non-ok status")
	}
}

// TestSessionClient_CreateAccessKey_NonOkIsError guards the conflict path: a
// non-ok add-key (e.g. duplicate name) must surface as an error so Run can
// delete the stale key and retry.
func TestSessionClient_CreateAccessKey_NonOkIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(apiResp{Status: "error", Msg: "duplicate"})
	}))
	t.Cleanup(srv.Close)
	c := NewSessionClient(srv.URL, 0)
	if err := c.CreateAccessKey(context.Background(), "n", "k", "s"); err == nil {
		t.Fatal("expected error for non-ok add-key")
	}
}

func TestSessionClient_DeleteAccessKey_SendsMinimalBody(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(apiResp{Status: "ok"})
	}))
	t.Cleanup(srv.Close)
	c := NewSessionClient(srv.URL, 0)
	if err := c.DeleteAccessKey(context.Background(), "stale"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if gotBody["owner"] != "built-in" || gotBody["name"] != "stale" {
		t.Fatalf("minimal body wrong: %v", gotBody)
	}
}

func TestSessionClient_HTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>502</html>"))
	}))
	t.Cleanup(srv.Close)
	c := NewSessionClient(srv.URL, 0)
	if err := c.Login(context.Background(), "x"); err == nil {
		t.Fatal("expected error on HTTP 502")
	}
}
