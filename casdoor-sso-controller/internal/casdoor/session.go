package casdoor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"time"
)

// SessionClient authenticates to Casdoor's admin API with a login session
// (username/password -> cookie). The bootstrap uses it to mint the controller's
// own M2M access key before any access key exists. It is a distinct transport
// from the accessKey-based httpClient the reconciler uses.
type SessionClient struct {
	baseURL string
	hc      *http.Client
}

// NewSessionClient builds a client whose http.Client carries a cookie jar, so
// the casdoor_session_id cookie set by Login is sent on later calls. nil jar
// options is intentional: the bootstrap talks to one in-cluster host, so the
// public-suffix list the jar normally uses is irrelevant.
func NewSessionClient(baseURL string, timeout time.Duration) *SessionClient {
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	jar, _ := cookiejar.New(nil)
	return &SessionClient{
		baseURL: baseURL,
		hc:      &http.Client{Timeout: timeout, Jar: jar},
	}
}

type apiResp struct {
	Status string          `json:"status"`
	Msg    string          `json:"msg"`
	Data   json.RawMessage `json:"data"`
}

// Login authenticates as the built-in admin user with the given password and
// stores the session cookie on the client's jar. The application/organization
// are Casdoor's built-in defaults; only the password varies.
func (c *SessionClient) Login(ctx context.Context, password string) error {
	body := map[string]any{
		"application":  "app-built-in",
		"organization": "built-in",
		"username":     "admin",
		"password":     password,
		"type":         "login",
		"autoSignin":   true,
	}
	var resp apiResp
	if err := c.do(ctx, http.MethodPost, "/api/login", nil, body, &resp); err != nil {
		return err
	}
	if resp.Status != "ok" {
		return fmt.Errorf("login: %s", resp.Msg)
	}
	return nil
}

// CreateAccessKey creates a User=admin access key with a CLIENT-SUPPLIED
// accessKey/accessSecret (Casdoor stores them verbatim) and state=Active. The
// caller generated the credential, so nothing is read back from Casdoor — the
// add-key response is just "Affected" and get-keys masks the secret.
func (c *SessionClient) CreateAccessKey(ctx context.Context, name, accessKey, accessSecret string) error {
	body := map[string]any{
		"owner":        "built-in",
		"name":         name,
		"displayName":  "LibrePod SSO Controller Key",
		"type":         "User",
		"organization": "built-in",
		"application":  "",
		"user":         "admin",
		"accessKey":    accessKey,
		"accessSecret": accessSecret,
		"state":        "Active",
	}
	var resp apiResp
	if err := c.do(ctx, http.MethodPost, "/api/add-key", nil, body, &resp); err != nil {
		return err
	}
	if resp.Status != "ok" {
		return fmt.Errorf("add-key %q: %s", name, resp.Msg)
	}
	return nil
}

// DeleteAccessKey removes a key by name with a minimal {owner,name} body
// (verified to work on Casdoor 3.106.0, unlike delete-application which needs
// the full object). Used to clear a stale same-name key before re-creating it.
func (c *SessionClient) DeleteAccessKey(ctx context.Context, name string) error {
	body := map[string]any{"owner": "built-in", "name": name}
	var resp apiResp
	if err := c.do(ctx, http.MethodPost, "/api/delete-key", nil, body, &resp); err != nil {
		return err
	}
	if resp.Status != "ok" {
		return fmt.Errorf("delete-key %q: %s", name, resp.Msg)
	}
	return nil
}

// do issues a cookie-authenticated request. Unlike httpClient.do it carries no
// accessKey/accessSecret query params (none exist during bootstrap); the cookie
// jar supplies the session cookie automatically.
func (c *SessionClient) do(ctx context.Context, method, path string, query url.Values, body any, out *apiResp) error {
	u := c.baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("casdoor %s %s: HTTP %d: %s", method, path, resp.StatusCode, b)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
