# First-Run Onboarding ("Claim Your Device") — Design

Companion plan: `docs/superpowers/plans/2026-09-05-onboarding-flow.md`.
Product record: `ui/PRODUCT.md`.
Date: 2026-09-02 (shaped) · 2026-09-05 (amended, user-directed) · Status: approved

## Problem

A fresh LibrePod has no DNS for `*.libre.pod`, so the owner reaches the UI over
the raw device IP (`http://192.168.x.y`). The app immediately redirects to SSO
at `id.libre.pod` — unresolvable — and the user is stuck on a dead redirect.
SSO-over-IP is impossible **by design** (hardcoded https redirect_uri +
Secure cookies). The fix is not to make SSO work over IP; it is to graduate
the user onto named, tunneled, trusted access.

## Goal

A raw-IP first-run wizard that takes a fresh cluster from `http://<device-ip>`
to: a claimed admin, a trusted root CA, a connected WireGuard tunnel (which
resolves `*.libre.pod`), and graduation to `https://<base-domain>` with the
first SSO login — no terminals involved.

## Decisions (resolved with user)

| Decision point | Choice |
|---|---|
| DNS unlock | WireGuard hands out DNS: wg-easy client configs set the device as resolver, so tunnel-up is the moment `*.libre.pod` starts resolving. Tunnel connection = tour climax. |
| Bootstrap detection | Casdoor's built-in factory credential (`built-in/admin`/`123`). Probe = attempt factory login: success → onboarding mode, rejection → claimed, unreachable → waiting. The takeover itself closes the window. **No marker state anywhere.** |
| Security model | Open claim window on the LAN, closes on completion (Synology/TrueNAS first-boot model). Race accepted. |
| Wizard shape | Full-service: the NestJS server proxies the wg-easy API (creates the peer, renders QR) and serves the root CA from the pod-mounted cert. The user never leaves the tab — the browser cannot reach any other host mid-tour. |
| Admin identity | **Single fixed owner**: `admin` in org `librepod`, `admin@<base-domain>`, `isAdmin: true`. The wizard asks for a password only — no username or email fields. The built-in admin's password is then randomized. (User-directed 2026-09-05.) |
| One password for the device | wg-easy has no SSO, so at claim time the SAME chosen password is adopted as wg-easy's admin password: persisted to Secret `marketplace-ui-wg-easy` **first**, rotation best-effort. Trade-offs accepted: the SSO admin password lives (base64) in that Secret (RBAC-scoped), and a later Casdoor password change does NOT propagate to wg-easy. |
| Finale | Graduation: same tab redirects to the **apex domain** (`https://<base-domain>`, not a subdomain — confirmed) → first SSO login as the new owner → MyApps. First-app install is post-tour. |
| Tour scope | Owner-only. Other users are a later Users control-panel feature reusing the Casdoor proxy. |

## Flow

Three pre-auth screens + a five-step wizard, all derived from one status
object (`GET /api/bootstrap/status`):

```
waiting   (casdoor unreachable)      → WakingScreen: "your LibrePod is waking up"
onboarding (factory login works)     → wizard: Welcome → Claim → Trust → Connect → Graduate
ready + domain arrival               → the normal authenticated app
ready + ip arrival + handshake seen  → UseDomainScreen ("your device has a name now")
ready + ip arrival, no handshake     → wizard resumes at Connect (honest state)
```

- **Claim** — password + confirm, fixed identity `admin@<base-domain>` shown
  as text. Server: ensure org `librepod` → ensure owner user → randomize the
  built-in admin's password (window closes **last**, so a failed claim is
  retryable and never locks the cluster) → adopt the same password on wg-easy
  (persist-first, best-effort).
- **Trust** — download the root CA (`GET /api/bootstrap/ca`, public like
  `root-ca.<domain>`), per-OS install instructions.
- **Connect** — create the first WireGuard peer, render the QR (server-side
  proxy with Basic-auth wg-easy credential), watch `latestHandshakeAt` live.
- **Graduate** — "your device now has a name" → open `https://<base-domain>`.

Step truth is derived from live cluster state on every render — reloads and
pod restarts resume for free; no wizard-local progress state.

## Security mechanics

- **`mp_onboarding` HMAC cookie** (sub `onboarding`, 8h TTL, httpOnly, NOT
  Secure — the wizard IS the http://IP experience). Minted by status/claim
  **only while unclaimed**; gates the wizard's WireGuard endpoints
  (peer-create, config, QR). Proof of presence before the door closed; it
  dies with the tour — post-graduation nobody can mint one, so the
  peer-creation endpoint 401s for cookie-less clients.
- **wg-easy default-password hole closed**: the factory password
  (`ChangeMeOnFirstLogin!`, committed to a public repo) is rotated at claim
  time to the user's chosen password. Persist-before-rotate ordering means a
  wg-easy outage during claim defers rotation (the lazy `ensurePassword()`
  completes it from the Secret) rather than losing the credential.
- **No rotation side effects in GET polls** — the status probe is write-free;
  rotation happens only in `claim` or lazily inside the wg API paths.

## Evidence (resolved from source, do not re-derive)

- Casdoor v3.106.0: `POST /api/login` is anonymous JSON (that's how the login
  page works) and sets a beego session cookie — the only auth
  `/api/set-password` accepts (form-encoded, rejects spaces). `get-user` /
  `add-user` / `get-organization` / `add-organization` behave as above. The
  owner must live in org `librepod` (app binding + `CheckLoginPermission`).
- wg-easy v15.3: every `/api/*` route accepts
  `Authorization: Basic admin:<password>` — stateless proxying, no session
  dance. `INIT_*` env is consumed only on first start into sqlite on the PVC,
  so API password rotations are Flux-safe.

## Out of scope

- User creation beyond the owner (later Users panel; also re-syncs the
  wg-easy password on Casdoor password changes).
- IP+SSO coexistence — deliberately impossible; the raw IP stays scaffolding.
- First-app install — post-tour, normal catalog flow.
