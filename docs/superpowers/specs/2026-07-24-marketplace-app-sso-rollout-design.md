# App SSO Rollout — vaultwarden, litellm, seafile, headscale

**Status:** Draft (researched 2026-07-24)
**Purpose:** Implementation spec for wiring native-OIDC SSO to four apps via the
`casdoor-sso-controller`. **Each app section (§5.1–§5.4) is a self-contained
brief** — spawn one parallel implementation session per app; no section depends
on another.

---

## 1. Scope

Exactly four apps, each gets SSO through Casdoor via a `SSOClient` CR:

| App | Image | Wiring "shape" |
|---|---|---|
| **vaultwarden** | `vaultwarden/server:1.36.0-alpine` | A — env vars |
| **litellm** | `litellm/litellm:v1.81.9-stable.patch.1` | A — env vars |
| **seafile** | `seafileltd/seafile-mc:13.0-latest` | B — config file |
| **headscale** | `headscale/headscale` + headplane UI | C — non-web (device-join) OIDC |

**Goal:** each app authenticates users through Casdoor with zero committed
secrets — the controller provisions the OIDC client and writes its
`clientId`/`clientSecret` into a per-app Secret at runtime.

### Non-goals

- Changing the controller or `SSOClient` CRD.
- Any app not listed above.

---

## 2. References

- **`docs/sso-app-author-guide.md`** — the canonical 3-step recipe (add
  `SSOClient` CR → wire chart to the controller's Secret →
  `dependsOn: casdoor-sso`). The recipe is reproduced in §4 so each session is
  self-contained; consult the guide for background.
- **`docs/superpowers/specs/2026-07-03-casdoor-sso-auto-provisioning-design.md`**
  — the controller build/design.
- Upstream SSO docs: vaultwarden `.env.template`; LiteLLM
  <https://docs.litellm.ai/docs/proxy/admin_ui_sso>; Seafile
  <https://manual.seafile.com/latest/config/oauth/#oauth>; Headscale
  <https://headscale.net/stable/ref/oidc/>.

---

## 3. The three wiring shapes

All four apps speak OIDC natively, but they consume config differently — which
is the only real per-app variation:

| Shape | App reads OIDC from | Author adds |
|---|---|---|
| **A. Env vars** | environment variables | `SSOClient` CR + `secretKeyRef` |
| **B. Config file** | a config file (not env) | `SSOClient` CR + an init-container/ConfigMap that injects the values |
| **C. Non-web OIDC** | authenticates *devices*, not user login | `SSOClient` CR + reachability/TLS-trust work |

vaultwarden + litellm = A; seafile = B; headscale = C.

**Cross-cutting note (applies to all four):** the controller writes the full
OIDC *discovery URL* (`.../.well-known/openid-configuration`) to its `issuer`
output key. Apps that want the **bare issuer** (vaultwarden `SSO_AUTHORITY`,
headscale `oidc.issuer`, seafile/litellm endpoint URLs) must take that value
from a **literal** env/config entry, **not** from the controller's `issuer`
key. Only `clientId`/`clientSecret` come from the Secret.

---

## 4. The common recipe (base for every app)

1. **Add an `SSOClient` CR** at `apps/<app>/overlays/librepod/ssoclient.yaml`
   and register it in the overlay's `kustomization.yaml` `resources:`.

   ```yaml
   apiVersion: marketplace.librepod.org/v1alpha1
   kind: SSOClient
   metadata:
     name: <app>-sso
     namespace: <app>
   spec:
     clientId: <app>                 # Casdoor app name + OIDC client_id (pick once, don't rename)
     organization: librepod
     redirectUris:
       - "https://<app>.${BASE_DOMAIN}/<callback>"   # controller expands ${BASE_DOMAIN}
     grantTypes: [authorization_code, refresh_token]
     tokenFormat: JWT
     expireInHours: 168
     output:
       secretName: <app>-sso         # Secret written into the app namespace
       keys:
         clientId: <APP>_CLIENT_ID          # env-var name THIS app expects
         clientSecret: <APP>_CLIENT_SECRET
         issuer: <APP>_ISSUER               # discovery URL; unused by bare-issuer apps (see §3)
     casdoorPolicy: retain
   ```

2. **Wire the chart to the Secret** with `valueFrom.secretKeyRef` (HelmRelease
   `extraEnvVars`, or raw Deployment `env:`):
   ```yaml
   - name: <APP>_CLIENT_ID
     valueFrom: { secretKeyRef: { name: <app>-sso, key: <APP>_CLIENT_ID } }
   - name: <APP>_CLIENT_SECRET
     valueFrom: { secretKeyRef: { name: <app>-sso, key: <APP>_CLIENT_SECRET } }
   ```

3. **Order the app after `casdoor-sso`** in its Flux Kustomization:
   ```yaml
   dependsOn:
     - name: casdoor-sso
   ```

4. **IngressRoute stays middleware-free** — these apps validate OIDC themselves;
   do **not** add `oauth2-forwardauth` middlewares.

5. **Verify:** `kubectl get ssoclient <app>-sso -n <app>` → `Ready`; the Secret
   has three keys; OIDC login works end-to-end.

Per-app sections below specify only the deltas from this recipe.

---

## 5.1 vaultwarden — Shape A (env vars)

Native OIDC ships in the **default build** since v1.35.0; 1.36.0 is the SSO
security release. Pure env-driven.

**`SSOClient` CR** — `clientId: vaultwarden`:
```yaml
redirectUris:
  - "https://vaultwarden.${BASE_DOMAIN}/oauth2/oidc-signin"   # ⚠ confirm exact path
output:
  secretName: vaultwarden-sso
  keys:
    clientId: SSO_CLIENT_ID
    clientSecret: SSO_CLIENT_SECRET
```

**Env vars** — non-secret ones as literal values (Flux substitutes `${BASE_DOMAIN}`):
```
SSO_ENABLED=true
SSO_AUTHORITY=https://sso.${BASE_DOMAIN}
SSO_SCOPES="openid email profile"
SSO_SIGNUPS_MATCH_EMAIL=true
SSO_PKCE=true
```
From the Secret via `secretKeyRef`: `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`.

**Gotchas**
- `SSO_AUTHORITY` is the bare issuer (vaultwarden appends discovery itself) →
  literal, **not** the controller's `issuer` key (§3).
- SSO gates *login* only; it does **not** replace per-user vault master
  passwords (`SSO_ONLY=true` forces SSO login but each user still has a master
  password).
- Set `SSO_SIGNUPS_MATCH_EMAIL=true` and leave
  `SSO_ALLOW_UNKNOWN_EMAIL_VERIFICATION=false` (default) to prevent email-spoof
  account takeover.
- Do not downgrade below 1.36.0.

**Open items**
- Confirm the exact OIDC redirect path (`/oauth2/oidc-signin` vs
  `/identity/connect/oidc-signin`) against the deployed version.

---

## 5.2 litellm — Shape A (env vars)

LLM gateway with an admin UI; native generic OIDC.

**`SSOClient` CR** — `clientId: litellm`:
```yaml
redirectUris:
  - "https://litellm.${BASE_DOMAIN}/sso/callback"
output:
  secretName: litellm-sso
  keys:
    clientId: GENERIC_CLIENT_ID
    clientSecret: GENERIC_CLIENT_SECRET
```

**Env vars** — non-secret ones as literal values:
```
GENERIC_AUTHORIZATION_ENDPOINT=https://sso.${BASE_DOMAIN}/login/oauth/authorize
GENERIC_TOKEN_ENDPOINT=https://sso.${BASE_DOMAIN}/login/oauth/access_token
GENERIC_USERINFO_ENDPOINT=https://sso.${BASE_DOMAIN}/api/userinfo
PROXY_BASE_URL=https://litellm.${BASE_DOMAIN}
```
From the Secret via `secretKeyRef`: `GENERIC_CLIENT_ID`, `GENERIC_CLIENT_SECRET`.
Redirect URI registered in Casdoor must allow
`https://litellm.${BASE_DOMAIN}/sso/callback` (and `/sso/key/generate`).

**Gotchas / drive-bys**
- `PROXY_BASE_URL` must include `https://` (bare host → redirect_uri errors).
- LiteLLM SSO is free for **≤5 users** (Enterprise above) — acceptable for
  personal/home clusters; note in metadata.
- `LITELLM_MASTER_KEY` stays (governs API access, orthogonal to UI SSO).
- **Drive-by fix:** the `LITELM_SALT_KEY` typo (missing `L`) in
  `base/litellm.env` — correct it and source it from the provisioned secret.

**Open items**
- Confirm the ≤5-user free tier is acceptable; decide the `PROXY_ADMIN_ID`
  seeding flow (first SSO user grants `proxy_admin`).

---

## 5.3 seafile — Shape B (config file)

Seafile CE reads OAuth from `seahub_settings.py` (generated into the `/shared`
PVC on first boot), **not** from env. The OAuth config itself is straightforward
per the manual; the one extra step is injecting it. CE supports **OAuth2**
(native OIDC/SAML is Pro-only) — pointing the OAuth2 flow at Casdoor's OIDC
endpoints with `openid` scope is the documented path.

**`SSOClient` CR** — `clientId: seafile`:
```yaml
redirectUris:
  - "https://seafile.${BASE_DOMAIN}/oauth/callback/"   # trailing slash required
output:
  secretName: seafile-sso
  keys:
    clientId: OAUTH_CLIENT_ID
    clientSecret: OAUTH_CLIENT_SECRET
```

**Packaging step (the Shape-B delta):** add an idempotent init container that
reads the controller's Secret and appends the OAuth block to
`/shared/seafile/conf/seahub_settings.py` (append-if-absent, since the image
generates the file once and preserves it):
```python
ENABLE_OAUTH = True
OAUTH_CLIENT_ID = os.environ["OAUTH_CLIENT_ID"]
OAUTH_CLIENT_SECRET = os.environ["OAUTH_CLIENT_SECRET"]
OAUTH_REDIRECT_URL = "https://seafile.${BASE_DOMAIN}/oauth/callback/"
OAUTH_PROVIDER = "casdoor"
OAUTH_AUTHORIZATION_URL = "https://sso.${BASE_DOMAIN}/login/oauth/authorize"
OAUTH_TOKEN_URL        = "https://sso.${BASE_DOMAIN}/login/oauth/access_token"
OAUTH_USER_INFO_URL    = "https://sso.${BASE_DOMAIN}/api/userinfo"
OAUTH_SCOPE = ["openid", "profile", "email"]
OAUTH_ATTRIBUTE_MAP = {
    "sub":   (True,  "uid"),
    "name":  (False, "name"),
    "email": (False, "contact_email"),
}
```

**Gotchas**
- Trailing slashes matter on the `OAUTH_*` URLs exactly as shown.
- Add `https://seafile.${BASE_DOMAIN}` to `CSRF_TRUSTED_ORIGINS` /
  `ALLOWED_HOSTS` or the OAuth callback POST is rejected.
- SSO-created users have no local password → set `ENABLE_WEBDAV_SECRET=True`
  if WebDAV desktop-sync clients are needed.

**Open items**
- Confirm `seafile-mc`'s first-boot generation/persist behavior so the init
  container's merge is idempotent (and whether the image offers a cleaner
  custom-settings include path).

---

## 5.4 headscale — Shape C (non-web, device-join OIDC)

Headscale OIDC authenticates a **device joining the tailnet** (browser redirect
at `tailscale up`, re-auth at node expiry), not a user logging into a UI. Config
reference: <https://headscale.net/stable/ref/oidc/>. The existing app already
has the `oidc:` block commented in `base/config.yaml` as a TODO.

**`SSOClient` CR** — `clientId: headscale`:
```yaml
redirectUris:
  - "https://headscale.${FRP_DOMAIN}/oidc/callback"   # publicly reachable BEFORE the node joins the VPN
output:
  secretName: headscale-sso
  keys:
    clientId: OIDC_CLIENT_ID
    clientSecret: OIDC_CLIENT_SECRET
```

**Headscale config** (`base/config.yaml`, uncomment + wire the `oidc:` block):
```yaml
oidc:
  issuer: "https://sso.${BASE_DOMAIN}"   # BARE issuer — headscale does discovery itself (§3)
  client_id:     "<from Secret: OIDC_CLIENT_ID>"
  client_secret: "<from Secret: OIDC_CLIENT_SECRET>"
  pkce:
    enabled: true            # recommended (S256); enable PKCE on the Casdoor client too
  email_verified_required: false   # unless Casdoor marks emails verified
```

**Secret-injection decision (the Shape-C delta):** headscale reads its config
from a YAML file (ConfigMap-mounted), and `client_secret` is an inline string.
Inject the controller-provisioned value via Flux `postBuild.substituteFrom`
reading the `headscale-sso` Secret into the config (confirm headscale has no
`client_secret_path`/env option that would be cleaner). `issuer` is a literal
bare URL (§3).

**Reachability/TLS gotchas**
- The OIDC callback **must** be reachable by a client *before* it is on the VPN
  → put it on `${FRP_DOMAIN}` (publicly relayed), not `${BASE_DOMAIN}`
  (internal). Ensure an IngressRoute/path exists for that host.
- Headscale must trust Casdoor's TLS → mount the step-ca root CA into the
  headscale pod (the existing TODO notes this).
- Headscale's username comes from the `preferred_username` claim and must match
  a strict pattern (≥2 chars, start with a letter, up to a single `@`).
  **Verify Casdoor's `preferred_username` format complies** (or the join fails).
- Limitation: OIDC groups cannot be used in headscale policy rules.

**Open items**
- Decide the secret-injection mechanism (Flux `substituteFrom` vs
  `client_secret_path` if headscale supports it).
- Confirm the `${FRP_DOMAIN}` callback host is exposed for headscale and that
  step-ca CA trust is wired.
- Verify Casdoor's `preferred_username` satisfies headscale's username pattern.

---

## 6. Decisions log

| Decision | Rationale |
|---|---|
| All four apps via `SSOClient` + controller Secret (the author-guide recipe) | Proven on the cluster; zero committed secrets. |
| Bare issuer / endpoint URLs are **literal** env/config values; only id+secret from the Secret | Avoids the controller's discovery-URL-vs-bare-issuer mismatch (§3). |
| Seafile on CE **OAuth2** (not native OIDC) | Native OIDC/SAML is Pro-only; OAuth2→Casdoor with `openid` scope is officially documented. |
| Headscale wired for **core device-join OIDC** (per the linked ref), not just the UI | That is headscale's SSO surface; the UI is secondary. |
| Headscale callback on `${FRP_DOMAIN}` | Must be reachable pre-VPN-join; `${BASE_DOMAIN}` is internal. |
| `email_verified_required: false` for headscale pending Casdoor claim verification | Avoid join failures if Casdoor doesn't set `email_verified`. |

---

## 7. Rollout / parallelization

Each of §5.1–§5.4 is an independent implementation brief. Spawn four parallel
sessions (one per app). Suggested order if sequenced: vaultwarden → litellm
(both Shape A, cheapest) → seafile (Shape B packaging) → headscale (Shape C +
reachability work). Each session follows the verify-app workflow (build → dev
cluster → `SSOClient` `Ready` + Secret populated → OIDC flow works).
