package casdoor

import (
	"context"
	"time"
)

// Application is a Casdoor Application represented as a generic map so the
// controller can carry every field of the baseline application template without
// modeling all 80+ fields in Go. Keys the controller sets explicitly are
// accessed via the typed helpers below.
type Application = map[string]any

// Field constants are the Casdoor Application JSON keys the controller reads or
// writes. Exported so the reconciler can address fields by typed constant
// instead of re-declaring (and risking typos in) the string literals.
const (
	FieldName         = "name"
	FieldOrganization = "organization"
	FieldClientID     = "clientId"
	FieldClientSecret = "clientSecret"
	FieldRedirectUris = "redirectUris"
	FieldScopes       = "scopes"
	FieldGrantTypes   = "grantTypes"
	FieldTokenFormat  = "tokenFormat"
	FieldExpireHours  = "expireInHours"
	FieldEnableSignUp = "enableSignUp"
	FieldDisplayName  = "displayName"
	FieldTitle        = "title"
)

// ManagedFields is the set of Casdoor Application keys the controller owns:
// keys it derives from typed SSOClientSpec fields or forces as platform policy
// (enableSignUp=false, identity == clientId, secret rotation). It is the
// denylist for spec.applicationOverrides — a CR must not be able to bypass
// platform policy or desync identity via a free-form override.
//
// Build() stamps every key here unconditionally AFTER merging overrides (and
// skips them while merging), and overrideKeys() excludes them from drift, so
// protection holds even if the override sets them. Expressed as field constants
// (not literals) so a rename is a compile error and a test can guard the link.
var ManagedFields = map[string]struct{}{
	FieldName:         {},
	FieldOrganization: {},
	FieldClientID:     {},
	FieldClientSecret: {},
	FieldRedirectUris: {},
	FieldGrantTypes:   {},
	FieldTokenFormat:  {},
	FieldExpireHours:  {},
	FieldEnableSignUp: {},
	FieldDisplayName:  {},
	FieldTitle:        {},
}

type Config struct {
	BaseURL string // e.g. http://casdoor.casdoor.svc.cluster.local:8000

	// AccessKey and AccessSecret are a Casdoor M2M Access Key (managed under
	// the Keys page), sent as query params on every admin-API request. Casdoor
	// runs the request with the key's scoped principal's permissions, so a
	// User=admin key grants full application CRUD (application management is
	// admin-only on Casdoor 3.x — an Organization-scoped key can read apps but
	// cannot add/update/delete them). See Casdoor "Public API" docs.
	AccessKey    string
	AccessSecret string

	// Timeout is the per-request timeout; defaults to 10s when zero.
	Timeout time.Duration
}

// Client talks to the Casdoor admin API.
type Client interface {
	// GetApplication fetches an application by its Casdoor name. The Casdoor
	// app name == the SSOClient CR's clientId (set by template.Build). The DB
	// owner of every application is always "admin", so callers do not pass an
	// owner — the HTTP client encodes the id as "admin/<name>".
	GetApplication(ctx context.Context, name string) (Application, bool, error)
	AddApplication(ctx context.Context, app Application) (Application, error)
	UpdateApplication(ctx context.Context, app Application) error
	// DeleteApplication removes an application. On Casdoor 3.x the
	// /api/delete-application endpoint requires the FULL application object as
	// the body (a {owner,name} body is a silent no-op), so callers must pass
	// the app previously returned by GetApplication. Used by the reconciler
	// when an SSOClient with casdoorPolicy: delete is removed.
	DeleteApplication(ctx context.Context, app Application) error
}

// Typed accessors used across the codebase.
func AppName(a Application) string         { v, _ := a[FieldName].(string); return v }
func AppClientID(a Application) string     { v, _ := a[FieldClientID].(string); return v }
func AppClientSecret(a Application) string { v, _ := a[FieldClientSecret].(string); return v }

func AppRedirectUris(a Application) []string {
	v, _ := a[FieldRedirectUris].([]any)
	out := make([]string, 0, len(v))
	for _, x := range v {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
