package casdoor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestServer(t *testing.T, handler http.Handler) (*httpClient, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &httpClient{baseURL: srv.URL, accessKey: "id", accessSecret: "sec", hc: srv.Client()}, srv
}

func TestGetApplication_Found(t *testing.T) {
	c, _ := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/get-application" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		if got := r.URL.Query().Get("id"); got != "admin/headscale" {
			t.Fatalf("id=%s, want admin/headscale", got)
		}
		// M2M Access Key is carried as query params (accessKey/accessSecret),
		// not as an Authorization header.
		if r.URL.Query().Get("accessKey") != "id" || r.URL.Query().Get("accessSecret") != "sec" {
			t.Fatalf("access-key query=%v", r.URL.Query())
		}
		if r.Header.Get("Authorization") != "" {
			t.Fatalf("unexpected Authorization header: %q", r.Header.Get("Authorization"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok",
			"data":   map[string]any{"name": "headscale", "clientId": "headscale", "clientSecret": "s3cr3t"},
		})
	}))
	app, found, err := c.GetApplication(context.Background(), "headscale")
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if !found {
		t.Fatal("expected found")
	}
	if AppClientID(app) != "headscale" || AppClientSecret(app) != "s3cr3t" {
		t.Fatalf("unexpected app=%v", app)
	}
}

// TestGetApplication_TransientErrorIsError guards finding #11: a non-ok status
// carrying a message is a real Casdoor error (permission/DB/backend), NOT a
// "missing application". Treating it as not-found would trigger a spurious
// AddApplication. Genuine misses return status="ok" + null data — covered by
// TestGetApplication_NotFound_StatusOkNullData.
func TestGetApplication_TransientErrorIsError(t *testing.T) {
	c, _ := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "error", "msg": "internal error", "data": nil})
	}))
	_, found, err := c.GetApplication(context.Background(), "x")
	if err == nil {
		t.Fatal("expected error for status=error with a message")
	}
	if found {
		t.Fatal("expected found=false")
	}
}

// TestGetApplication_NotFound_StatusOkNullData is the regression guard for BUG E.
//
// Casdoor 2.x returns status="ok" with data=null for a missing application
// (verified against Casdoor 2.353.1), NOT status="error". The old code checked
// only ar.Status != "ok", so it treated a missing app as found (nil map),
// flagged drift, and tried to update a non-existent application — surfacing as
// "Unauthorized operation" on the very first reconcile of a new SSOClient.
//
// This test encodes the real response shape and asserts the client returns
// not-found, so the contract cannot silently regress.
func TestGetApplication_NotFound_StatusOkNullData(t *testing.T) {
	c, _ := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Exact shape Casdoor 2.x returns for an absent application.
		_, _ = w.Write([]byte(`{"status":"ok","msg":"","data":null,"data2":null,"data3":null}`))
	}))
	_, found, err := c.GetApplication(context.Background(), "nope")
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if found {
		t.Fatal("expected not-found for status=ok + null data (BUG E)")
	}
}

func TestAddApplication(t *testing.T) {
	var gotBody map[string]any
	c, _ := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/add-application" {
			_ = json.NewDecoder(r.Body).Decode(&gotBody)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok",
				"data":   "Affected(1)",
			})
			return
		}
		if r.URL.Path == "/api/get-application" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok",
				"data":   map[string]any{"name": "x", "clientId": "x", "clientSecret": "s"},
			})
			return
		}
	}))
	got, err := c.AddApplication(context.Background(), Application{"name": "x", "clientSecret": "s"})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if gotBody["name"] != "x" {
		t.Fatalf("body=%v", gotBody)
	}
	// The whole point of the re-read is to surface Casdoor-generated credentials.
	if AppClientID(got) != "x" || AppClientSecret(got) != "s" {
		t.Fatalf("re-read lost credentials: %v", got)
	}
}

func TestUpdateApplication(t *testing.T) {
	var gotBody map[string]any
	var gotID string
	c, _ := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/update-application" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		gotID = r.URL.Query().Get("id")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": "Affected(1)"})
	}))
	err := c.UpdateApplication(context.Background(), Application{"name": "x"})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if gotBody["name"] != "x" {
		t.Fatalf("body=%v", gotBody)
	}
	// Regression guard: /api/update-application requires id=admin/<name> in the
	// query string. Without it Casdoor returns "wrong token count for ID:",
	// silently breaking drift-correction and secret rotation.
	if gotID != "admin/x" {
		t.Fatalf("id query=%q, want admin/x", gotID)
	}
}

// TestDeleteApplication_BodyContract asserts /api/delete-application is sent the
// FULL application object as the body. On Casdoor 3.x a minimal {owner, name}
// body is a silent no-op (status=ok, data="Unaffected"), so the client must pass
// the whole app exactly as the web UI does. It must NOT use the id=admin/<name>
// query param that get/update-application use.
func TestDeleteApplication_BodyContract(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	var gotQuery map[string][]string
	c, _ := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.Query()
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": "Affected(1)"})
	}))
	app := Application{"owner": "admin", "name": "headscale", "organization": "librepod", "displayName": "Headscale"}
	if err := c.DeleteApplication(context.Background(), app); err != nil {
		t.Fatalf("err=%v", err)
	}
	if gotPath != "/api/delete-application" {
		t.Fatalf("path=%s", gotPath)
	}
	// The body must carry the full object — at minimum owner + name + the
	// non-minimal fields that distinguish this from the no-op {owner,name} form.
	if gotBody["owner"] != "admin" || gotBody["name"] != "headscale" || gotBody["organization"] != "librepod" {
		t.Fatalf("body=%v, want the full application object", gotBody)
	}
	// No id query param — delete-application does not use the id=admin/<name>
	// contract that get/update do.
	if _, ok := gotQuery["id"]; ok {
		t.Fatalf("delete-application must not send an id query param; got %v", gotQuery)
	}
}

// TestDeleteApplication_UnaffectedIsError guards against Casdoor's silent no-op:
// status=ok + data="Unaffected" means nothing was deleted. The client must
// surface this as an error so the reconciler keeps the finalizer and retries
// instead of dropping the CR while the Casdoor app leaks.
func TestDeleteApplication_UnaffectedIsError(t *testing.T) {
	c, _ := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": "Unaffected"})
	}))
	err := c.DeleteApplication(context.Background(), Application{"owner": "admin", "name": "x"})
	if err == nil {
		t.Fatal("expected error for data=Unaffected")
	}
}

func TestGetApplication_HTTPError(t *testing.T) {
	c, _ := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>502 Bad Gateway</html>"))
	}))
	_, _, err := c.GetApplication(context.Background(), "x")
	if err == nil {
		t.Fatal("expected error on HTTP 502")
	}
}

func TestAddApplication_ReReadNotFound(t *testing.T) {
	c, _ := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/add-application":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": "Affected(1)"})
		case "/api/get-application":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "error", "msg": "not found", "data": nil})
		}
	}))
	_, err := c.AddApplication(context.Background(), Application{"name": "x"})
	if err == nil {
		t.Fatal("expected error when created application is not readable")
	}
}

// TestGetApplication_IDContract is the regression guard for BUG C1.
//
// Casdoor's /api/get-application requires id = "<owner>/<name>", and the
// owner of every application is "admin" (verified against casdoor-go-sdk:
// GetApplication sends id=fmt.Sprintf("%s/%s", "admin", name)). The separate
// `owner` query param is IGNORED by this endpoint — passing a bare name as
// `id` makes Casdoor split on "/", find no slash, and return not-found.
//
// This test asserts the request URL carries id="admin/<name>" and NO owner
// param, so the contract cannot silently regress. Under the old (buggy) code,
// which sent id=<bare name> and an extra owner=<org>, this test fails.
func TestGetApplication_IDContract(t *testing.T) {
	var seenURL string
	var seenQuery map[string][]string
	c, _ := newTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenURL = r.URL.Path
		seenQuery = r.URL.Query()
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": map[string]any{"name": "whatever"}})
	}))
	if _, _, err := c.GetApplication(context.Background(), "whatever"); err != nil {
		t.Fatalf("err=%v", err)
	}
	if seenURL != "/api/get-application" {
		t.Fatalf("path=%s", seenURL)
	}
	// The id MUST be admin/<name> — Casdoor keys applications by owner/name
	// with owner always "admin" for applications.
	idVals := seenQuery["id"]
	if len(idVals) != 1 || idVals[0] != "admin/whatever" {
		t.Fatalf("id query = %v, want [%q] (Casdoor id contract: owner/name)", idVals, "admin/whatever")
	}
	// The obsolete `owner` param MUST NOT be sent — Casdoor ignores it for
	// get-application, and sending it implies the wrong API contract.
	if _, ok := seenQuery["owner"]; ok {
		t.Fatalf("owner param should not be sent; got query=%v", seenQuery)
	}
}
