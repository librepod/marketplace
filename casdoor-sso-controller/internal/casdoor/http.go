package casdoor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type httpClient struct {
	baseURL      string
	accessKey    string
	accessSecret string
	hc           *http.Client
}

func New(cfg Config) Client {
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	return &httpClient{
		baseURL:      cfg.BaseURL,
		accessKey:    cfg.AccessKey,
		accessSecret: cfg.AccessSecret,
		hc:           &http.Client{Timeout: timeout},
	}
}

type apiResponse struct {
	Status string          `json:"status"`
	Msg    string          `json:"msg"`
	Data   json.RawMessage `json:"data"`
}

// do issues a Casdoor admin-API call authenticated with the M2M Access Key
// (accessKey/accessSecret as query params), which Casdoor treats as the key's
// scoped principal. The controller uses a User=admin key (application management
// is admin-only on 3.x), so this grants full application CRUD. Empty values
// yield "Unauthorized operation", which the reconciler backs off and retries
// until the credentials are populated.
func (c *httpClient) do(ctx context.Context, method, path string, query url.Values, body any) (apiResponse, error) {
	// Access-key auth is carried as query params on every request, merged ahead
	// of any caller-supplied query (e.g. id=admin/<name>).
	q := url.Values{}
	q.Set("accessKey", c.accessKey)
	q.Set("accessSecret", c.accessSecret)
	for k, vs := range query {
		q[k] = vs
	}
	u := c.baseURL + path + "?" + q.Encode()

	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return apiResponse{}, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return apiResponse{}, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return apiResponse{}, err
	}
	defer resp.Body.Close()
	// Non-2xx means we never reached Casdoor's business layer (e.g. a Traefik
	// 502 HTML page or an auth 401). Surface the status instead of mis-decoding.
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return apiResponse{}, fmt.Errorf("casdoor %s %s: HTTP %d: %s", method, path, resp.StatusCode, body)
	}
	var ar apiResponse
	if err := json.NewDecoder(resp.Body).Decode(&ar); err != nil {
		return apiResponse{}, fmt.Errorf("decode casdoor response: %w", err)
	}
	return ar, nil
}

// GetApplication fetches a Casdoor application by name. Casdoor's
// /api/get-application requires id = "<owner>/<name>", and the owner of every
// application is "admin" (verified against casdoor-go-sdk: GetApplication sends
// id=fmt.Sprintf("%s/%s", "admin", name)). The separate `owner` query param is
// IGNORED by this endpoint, so it is not sent. See TestGetApplication_IDContract.
func (c *httpClient) GetApplication(ctx context.Context, name string) (Application, bool, error) {
	q := url.Values{}
	q.Set("id", "admin/"+name)
	ar, err := c.do(ctx, http.MethodGet, "/api/get-application", q, nil)
	if err != nil {
		return nil, false, err
	}
	// Casdoor returns non-ok status ("error"/"none") on some versions, but
	// Casdoor 2.x returns status="ok" with data=null for a missing application.
	// A non-ok status WITH a message is a real error (permission/DB/backend) and
	// must not be mistaken for "application does not exist" — that would trigger
	// a spurious AddApplication. A non-ok status with no message, or ok + null
	// data, is a genuine miss.
	if ar.Status != "ok" {
		if strings.TrimSpace(ar.Msg) != "" {
			return nil, false, fmt.Errorf("get-application: %s", ar.Msg)
		}
		return nil, false, nil
	}
	var app Application
	if err := json.Unmarshal(ar.Data, &app); err != nil {
		return nil, false, fmt.Errorf("unmarshal application: %w", err)
	}
	if len(app) == 0 {
		return nil, false, nil
	}
	return app, true, nil
}

func (c *httpClient) AddApplication(ctx context.Context, app Application) (Application, error) {
	ar, err := c.do(ctx, http.MethodPost, "/api/add-application", nil, app)
	if err != nil {
		return nil, err
	}
	if ar.Status != "ok" {
		return nil, fmt.Errorf("add-application: %s", ar.Msg)
	}
	// Casdoor returns the created object only via get-application; re-read it.
	// Key by the app's name (== the CR's clientId); the DB owner is always
	// "admin", encoded inside GetApplication.
	name, _ := app[FieldName].(string)
	got, found, err := c.GetApplication(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("add-application: re-read failed: %w", err)
	}
	if !found {
		return nil, fmt.Errorf("add-application: created %q but not readable", name)
	}
	return got, nil
}

func (c *httpClient) UpdateApplication(ctx context.Context, app Application) error {
	// /api/update-application requires id = "admin/<name>" in the query string
	// (same contract as get-application). Without it Casdoor returns
	// "GetOwnerAndNameFromId() error, wrong token count for ID: " — the bug
	// that broke drift-correction and rotation before this was added.
	q := url.Values{}
	q.Set("id", "admin/"+AppName(app))
	ar, err := c.do(ctx, http.MethodPost, "/api/update-application", q, app)
	if err != nil {
		return err
	}
	if ar.Status != "ok" {
		return fmt.Errorf("update-application: %s", ar.Msg)
	}
	return nil
}

// DeleteApplication removes an application. On Casdoor 3.x /api/delete-application
// IGNORES a minimal {owner, name} body (returns status=ok, data="Unaffected" — a
// silent no-op) and requires the FULL application object as the body, exactly as
// the web UI sends it. On 2.x a {owner, name} body sufficed; that no longer works.
// Callers must pass the app previously returned by GetApplication.
func (c *httpClient) DeleteApplication(ctx context.Context, app Application) error {
	ar, err := c.do(ctx, http.MethodPost, "/api/delete-application", nil, app)
	if err != nil {
		return err
	}
	if ar.Status != "ok" {
		return fmt.Errorf("delete-application: %s", ar.Msg)
	}
	// Guard against the silent no-op: "Affected" (or "Affected(1)") means a row
	// was deleted; "Unaffected" means nothing matched — surface it as an error so
	// the controller doesn't drop the finalizer on a non-deletion.
	if s := string(ar.Data); s == `"Unaffected"` {
		return fmt.Errorf("delete-application: nothing deleted (data=%s) — pass the full application object", s)
	}
	return nil
}
