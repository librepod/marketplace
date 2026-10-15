# First-Run Onboarding with a Setup Code — Design

**Status:** design approved in brainstorming; written spec awaiting review
**Date:** 2026-10-14
**Branch:** `feat/onboarding-setup-code` (fresh from master)
**Supersedes:** the unmerged 2026-09-05 onboarding design and its plan (PR #215).
The parts of #215 that survive are carried over (see "Carried over from PR #215").

## 1. Problem

A fresh LibrePod is reached over its raw IP (`http://<ip>`). SSO cannot work
there: Casdoor's redirect URIs are https on `*.<base-domain>` and its cookies
are Secure. The owner must be moved onto named, trusted, encrypted access
before the first SSO sign-in.

PR #215 solved this for a home device whose LAN is trusted: whoever reached the
raw IP first could claim it, and the wizard stayed open until a WireGuard
handshake was seen. Two problems ended that design:

- **The handshake is live state.** After a wg-easy restart no handshake is
  known, the wizard reopened, and any LAN visitor got the onboarding cookie —
  and with it every existing peer's QR code and config, private keys included.
- **Not every LibrePod sits on a trusted home LAN.** marketplace is a public,
  open-source repo: anyone can install it on any Kubernetes cluster — a cloud
  VM with a public IP, a VM on a shared corporate network, a homelab without
  LibrePod OS. "First visitor wins" hands a public-IP device to whichever
  internet scanner finds it first.

## 2. Goal

A raw-IP web wizard that takes a fresh install from `http://<ip>` to a claimed
device, a personal user, a trusted root CA, working connectivity and the first
SSO sign-in at `https://<base-domain>` — where:

- claiming requires a **setup code** that only someone with access to the
  machine or cluster can read;
- the raw IP serves the wizard **only until onboarding finishes**; after that,
  everything goes through the domain (VPN-first);
- the VPN is **replaceable**: wg-easy is the default, and advanced users can
  bring their own connectivity (Headscale/Tailscale, cloudflared, their own
  DNS);
- onboarding state is **durable** and survives restarts of any app;
- a lost password or an abandoned setup is recoverable with one command.
  VPN keys, including the replacement for a lost one, are managed on
  wg-easy's own page.

## 3. Environments

| Environment | Who reaches the raw IP | What changes |
|---|---|---|
| Home device (LibrePod OS) | the household LAN | v1: the code is read over ssh with `kubectl logs` (console display is an OS follow-up); plain http on the LAN |
| Cloud VM, public IP | the whole internet | the setup code stops scanners; plain http crosses the internet (accepted for v1, see §11) |
| VM on a corporate network | many colleagues | the setup code stops the race; company DNS and UDP may be locked down → "bring my own" |
| Any Kubernetes cluster, no LibrePod OS | depends | the code is read with `kubectl logs`; wg-easy may not run (§9) |

One flow serves all four. There is no per-environment branching.

## 4. Decisions (resolved with user, 2026-10-14)

| Decision point | Choice |
|---|---|
| Proof of ownership | A setup code created by marketplace-ui on first start, readable only via the cluster (pod log) or a distribution's console. Not "first visitor wins". |
| Who owns the code | marketplace (works on any cluster). LibrePod OS may later wrap it (sticker code, console display, host command) — a follow-up. |
| After onboarding | VPN-first: the raw IP stops serving the wizard; Marketplace UI is reached only at `https://<base-domain>`. |
| What finishes onboarding | The first SSO sign-in at `https://<base-domain>`. VPN-agnostic: it proves the name resolves, the CA is trusted and the user holds a password. |
| VPN | wg-easy stays a regular catalog app, installed by the wizard through the catalog's install path. "I'll bring my own" is a first-class alternative. |
| Identities | `admin` = the god-mode account; its password is the default admin password of every app that ships one (Casdoor's built-in admin now, wg-easy, later others). The owner then creates a **personal user** (e.g. `alex@libre.pod`) for daily SSO sign-in. |
| Where state lives | OpenBao `system/`: the onboarding record (incl. the setup code) and the admin password, both readable. LibrePod is a trusted perimeter; advanced users can read the admin password there. |
| Recovery | A reset command (`kubectl exec … reset-onboarding`) issues a new setup code and reopens onboarding. Apps, data, users and VPN peers stay. |
| Transport | Plain http on the raw IP for v1; `https://<ip>` (one certificate warning) and an ssh tunnel are documented for cloud installs. |
| Delivery | A fresh branch from master; the surviving parts of PR #215 are carried over as clean commits; #215 is closed with a pointer. |

## 5. States and screens

marketplace-ui keeps one onboarding record. The device is always in one of
four states:

| State | Meaning |
|---|---|
| `waiting` | OpenBao is unreachable, or the state is `open`/`claimed` and Casdoor is unreachable |
| `open` | a setup code exists; nobody has claimed with it |
| `claimed` | the admin password was set with the current code; no SSO sign-in yet |
| `finished` | a user signed in with SSO once since the last claim |

A reset moves `claimed` or `finished` back to `open` with a new code.

What each visitor sees:

| State | At the raw IP | At the domain |
|---|---|---|
| `waiting` | WakingScreen ("your LibrePod is waking up") | WakingScreen |
| `open` | wizard: Welcome → Claim | "Not set up yet — open this device's IP address to start" |
| `claimed`, browser holds the onboarding cookie | wizard continues (Account → VPN → …) | normal SSO sign-in, which finishes onboarding |
| `claimed`, no cookie | ResumeScreen: "Enter the setup code to continue" | normal SSO sign-in |
| `finished` | UseDomainScreen ("open `https://<base-domain>`") — no wizard, no cookie | the app |

A domain arrival that carries a valid SSO session always gets the app, without
consulting the onboarding record — a transient OpenBao or Casdoor outage must
not tell a signed-in user their device is "waking up". Raw-IP browsers never
carry the SSO session (it is a Secure cookie bound to the domain).

### Wizard

```
Welcome → Claim → Account → VPN ─┬─ "Set up WireGuard" → Trust → Connect → Graduate
                                 └─ "I'll bring my own" → Trust → Graduate (with checklist)
```

There is no "Set up later": until the first sign-in the wizard is the only way
in. The owner can leave at any point and come back with the setup code.

Step truth (state `claimed`, valid cookie) is derived from live state on every
render, as in #215:

- no account recorded → Account
- VPN app `not_installed` → VPN (the path choice is page state; a reload asks again)
- VPN app `installing`, `running` or `error`, no peers → Trust
- peers, no handshake → Connect
- handshake seen → Graduate

The "bring my own" path is page state only: Trust → Graduate. The Graduate
screen polls status and switches to UseDomainScreen once the state is
`finished`.

## 6. Setup code and reset

**Format.** 12 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O,
1/I/L), shown as three groups of four: `7KQM-X3RT-9VHC` (about 59 bits).
Input is upper-cased and stripped of dashes and spaces. Compared in constant
time. Guessing is not realistic, so there is no rate limit; failed attempts
are logged (source address, never the attempted value).

**Creation.** On every start marketplace-ui reads the onboarding record. If
there is none, it creates `{ state: open, code, generation: 1 }` with OpenBao
KV check-and-set (`cas: 0`), so two pods starting together cannot both create
a code. If OpenBao is not ready yet, it retries in the background; status
reports `waiting` meanwhile.

**Showing it.** While the state is `open` or `claimed`, every start logs one
line:

```
LibrePod setup code: 7KQM-X3RT-9VHC — open http://<this device's IP> to set up
```

The README documents `kubectl -n marketplace-ui logs deploy/marketplace-ui | grep "setup code"`.
Once `finished`, the code is never logged again.

**Validity.** The code claims the device in `open` and resumes the wizard in
`claimed`. It is dead once `finished`.

**Reset.** `kubectl -n marketplace-ui exec deploy/marketplace-ui -- reset-onboarding`
runs a small script shipped in the image. It signs in to OpenBao the same way
the server does (Kubernetes auth), writes a new code with `state: open`,
`generation + 1`, clears `claimedAt`/`finishedAt`, keeps `account`, and
prints the new code. It exits non-zero if OpenBao is unreachable. The server
caches the record for at most 5 seconds, so the reset takes effect without a
restart.

The reset leaves the admin password, users, installed apps, their data and VPN
peers alone. It is the recovery for: a lost personal password (§8 Account), a
lost admin password (§8 Claim sets a new one), and an abandoned setup. It does
not recover a lost VPN key: the wizard only makes the first key. A replacement
key is made on wg-easy's page, `wg-easy.<base-domain>`, from any device that
can still reach the domain.

## 7. Identities and credentials

| Identity | Where | Password | Used for |
|---|---|---|---|
| `admin` (Casdoor `built-in/admin`) | Casdoor built-in org | the admin password, set at the claim | Casdoor's superuser; the default admin password of every app that ships one (wg-easy's local admin now); marketplace-ui's credential for Casdoor admin calls |
| personal user, e.g. `alex` | Casdoor org `librepod` (`CASDOOR_ORG_NAME`), `alex@<base-domain>`, `isAdmin: true` (org admin, not global) | chosen in the Account step | daily SSO sign-in everywhere; full rights in Marketplace UI |

Password rule for both: at least 12 characters, no whitespace — checked by the
server and in the browser. Twelve because wg-easy rejects shorter admin
passwords at login; no whitespace because Casdoor's set-password rejects it.

**OpenBao layout** (KV v2 mount `system/`):

| Path | Holds |
|---|---|
| `system/marketplace-ui/onboarding` | `state`, `code`, `generation`, `account`, `createdAt`, `claimedAt`, `finishedAt` |
| `system/admin` | `password` — the admin password, readable (trusted perimeter) |

A new policy file `marketplace-ui-system.hcl` grants create/update/read on
`system/data/marketplace-ui/*` and `system/data/admin`. It is attached to the
`marketplace-ui` Kubernetes-auth role in `bootstrap.sh`, and the bootstrap
Job's `openbao.librepod/policies-version` is bumped so it re-runs once.

The Casdoor SSO controller is unaffected by the admin password changing: it
uses the built-in admin password only on first boot, to mint its own access
key, and authenticates with that key afterwards.

## 8. Claim, account, resume, finishing

**Claim** — `POST /api/bootstrap/claim { code, password }`, state `open`.
Each step is idempotent, so a failed claim is simply retried:

1. Check the code. Wrong → 403 "That setup code isn't right".
2. Check the password rule. Broken → 400.
3. Sign in to Casdoor as the built-in admin, trying in order: the password in
   `system/admin` (present after a reset), the factory `123`
   (`CASDOOR_ADMIN_DEFAULT_PASSWORD`), and the new password itself — the last
   one makes a retry after a crash between steps 4 and 5 succeed. None works →
   409 "Casdoor's admin password was changed outside LibrePod".
4. Set the built-in admin's password to the new one (skipped if step 3
   signed in with it).
5. Write it to `system/admin`.
6. Ensure the `librepod` organization exists.
7. Write the record: `state: claimed`, `claimedAt`.
8. Set the onboarding cookie.

`claimed` or `finished` → 409 (in `claimed`, the browser should resume
instead).

**Account** — `POST /api/bootstrap/account { username, password? }`,
cookie-gated, state `claimed`. The username is lowercase letters, digits,
dots and dashes, 1–39 characters, not `admin`. marketplace-ui signs in to
Casdoor as the built-in admin (password from `system/admin`):

- the user does not exist → create it in org `librepod` with
  `email: <username>@<base-domain>`, `isAdmin: true`; `password` is required;
- the user exists (after a reset) → keep it, or set a new password when
  `password` is given — the recovery for a forgotten personal password.

Then it records `account` in the onboarding record, so Graduate can say "Sign
in as `alex@libre.pod`" and a post-reset Account step can offer "keep alex".

**Resume** — `POST /api/bootstrap/resume { code }`, state `claimed`. Right
code → set the onboarding cookie; the wizard picks up at the first unfinished
step. Wrong → 403.

**Finishing.** The SSO callback (`/api/auth/callback`), after a successful
sign-in while the state is `claimed`, writes `state: finished`, `finishedAt`.
Only the first user exists at that point. If the write fails, the sign-in
still succeeds; the next authenticated `GET /api/bootstrap/status` retries it.

**Onboarding cookie** (`mp_onboarding`, kept from #215): HMAC-signed by
SessionService with `sub: 'onboarding'` plus the record's `generation`; 8h
TTL; httpOnly; NOT Secure (the wizard is the http://IP experience); SameSite
lax. AuthGuard rejects `sub === 'onboarding'` — it never authenticates as a
session. Set only by the claim and by resume — never by the status check.
`OnboardingGuard` accepts it only while the state is `claimed` and the
`generation` matches, so a cookie from before a reset, or after finishing, is
refused. It gates: account, the VPN install, the WireGuard endpoints and the
status telemetry.

## 9. VPN paths

**"Set up WireGuard"** (default, recommended):

- **Install.** `POST /api/bootstrap/install { app: 'wg-easy', settings }`,
  cookie-gated, `app` on the VPN allowlist, delegating to
  `InstalledService.install()` — same validation, OpenBao write and Gogs
  commit as the catalog; 409 "already installed" counts as success. The
  browser sends no password: the allowlist entry names the app's admin-password
  setting (`INIT_PASSWORD` for wg-easy), and the server fills it from
  `system/admin`.
- **Endpoint.** The VPN step shows the WireGuard endpoint host, editable,
  pre-filled with `endpointSuggestion` from status: the host the browser used
  to reach the wizard when that is an IP literal other than loopback or
  link-local (the LAN IP at home, the public IP on a cloud VM); otherwise
  `DEVICE_IP`. The wizard always sends it as the `INIT_HOST` setting.
- **Trust.** Download the root CA (`GET /api/bootstrap/ca`, public, like
  `root-ca.<domain>`), per-OS install instructions. Unchanged from #215.
- **Connect.** Driven by `vpnStatus`: `installing` → "Setting up WireGuard…";
  `running` → create the first peer, show its QR code and config download,
  watch `latestHandshakeAt`. On `error`, or `installing` for more than five
  minutes, Connect explains that WireGuard couldn't start on this device and
  offers "Use my own connectivity instead" (→ the other path's Graduate).
  wg-easy stays installed; the owner can uninstall it from the catalog.
- **Graduate.** "Open `https://<base-domain>` and sign in as `alex@libre.pod`."
  The wizard connects one device and stops there; Graduate has no way back
  to Connect. Further devices are added on wg-easy's own page,
  `wg-easy.<base-domain>`, after sign-in, so the owner learns one place for
  devices instead of reopening the wizard.

The handshake only drives the Connect screen. It no longer decides anything
about access.

**"I'll bring my own":** Trust → Graduate with a checklist: `<base-domain>`
and `*.<base-domain>` resolve to this device from your devices (your VPN,
tunnel or DNS); the root CA is trusted; then open `https://<base-domain>` and
sign in. The wizard cannot verify any of it; it waits for the state to become
`finished`.

**wg-easy catalog changes** (on top of master's current wg-easy):

- `INIT_PASSWORD`: required, sensitive, **no default** (master's
  `change-me` is shorter than wg-easy's 12-character minimum, so that admin
  could never log in). The description asks for the LibrePod admin password
  and states the minimum.
- New optional setting `INIT_HOST`, label "Endpoint host": the address
  devices dial; empty means this device's IP. A non-empty answer must override
  the ConfigMap value (the `wg-easy-settings` Secret comes after the ConfigMap
  in `envFrom`, so it wins); an empty answer must not end up as an empty key in
  that Secret.
- `wg-easy.env`: `INIT_HOST=${DEVICE_IP:=}` replaces `${FRP_SERVER_ADDR}`
  (empty, never junk, if ever applied unsubstituted). The release template
  substitutes only `BASE_DOMAIN` and `DEVICE_IP`; pass-through variables that
  nothing fills on a catalog install are dropped (they rendered as literal
  `${…}` text and broke the apply).

**`DEVICE_IP` platform variable** (carried from #215): the `InternalIP` of the
node marketplace-ui runs on, IPv4 preferred (downward-API `NODE_NAME` + `get`
on nodes in its ClusterRole). Computed only when a template references
`${DEVICE_IP}`, after settings validation and before any write; failure is a
retryable 503 ("couldn't determine this device's address").

**Generic clusters.** wg-easy needs the `net.ipv4.conf.all.src_valid_mark`
sysctl (LibrePod OS allows it in the kubelet config; most clusters reject it)
and a reachable UDP 51820. Where either is missing, the Connect fallback
above applies.

## 10. API surface

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/bootstrap/status` | public; read-only; never sets a cookie | state, arrival, base domain; telemetry only with a valid onboarding cookie |
| `POST /api/bootstrap/claim` | setup code in body | §8 |
| `POST /api/bootstrap/resume` | setup code in body | §8 |
| `POST /api/bootstrap/account` | onboarding cookie | §8 |
| `POST /api/bootstrap/install` | onboarding cookie | §9 |
| `GET /api/bootstrap/wireguard`, `POST …/peer`, `GET …/clients/:id/configuration`, `GET …/clients/:id/qrcode.svg` | onboarding cookie | peer list, create, config, QR (kept from #215) |
| `GET /api/bootstrap/ca` | public | root CA download (kept from #215) |

`/api/bootstrap/*` stays exempt from AuthGuard. Status shape:

```ts
type OnboardingState = 'waiting' | 'open' | 'claimed' | 'finished'
interface OnboardingStatus {
  state: OnboardingState
  arrival: 'ip' | 'domain'          // IPv4/IPv6 literal host = 'ip'
  baseDomain: string
  session: boolean                  // valid onboarding cookie for this generation
  // the rest is null unless `session`:
  account: string | null
  vpnStatus: AppStatus | null
  peerCount: number | null
  lastHandshakeAt: string | null
  endpointSuggestion: string | null
}
```

`BOOTSTRAP_MODE_OVERRIDE` stays as the test seam (Tier 1 forces `finished`).

## 11. Security notes

- **Proof of ownership** is reading the code from the cluster or console.
  Anyone with `kubectl logs` on marketplace-ui can claim — by design; on a
  cluster that ships pod logs elsewhere, the code travels with them until
  onboarding finishes.
- **Plain http (v1).** The code, the admin password, the personal password and
  the onboarding cookie cross the network unencrypted. The code defeats
  scanners and LAN bystanders; an on-path observer (hosting provider, transit
  network) is not defeated. Accepted for v1; the README tells cloud installs to
  use `https://<ip>` (one certificate warning, the root CA is not trusted yet)
  or an ssh tunnel.
- **Trusted perimeter.** The admin password and the setup code are stored
  readable in OpenBao `system/`. Whoever can read those paths already controls
  the device.
- **Closing for good.** After `finished`, no request can obtain an onboarding
  cookie, and existing cookies are refused. Only a reset (cluster access)
  reopens onboarding.
- **Fail closed.** OpenBao unreachable → `waiting`; the wizard and every
  cookie-gated endpoint are unavailable.
- **No writes in GET**, except the retried finish write for an authenticated
  status call (§8).

## 12. Carried over from PR #215

Kept, adapted where this design changes them:

1. `DEVICE_IP`: `NodeAddressService`, the installer's platform-variable block,
   the nodes RBAC rule and `NODE_NAME` env, `RESERVED_NAMES`, the librepod-app
   skill text, verify-app's `--device-ip` flag.
2. wg-easy as a catalog app (`metadata.yaml`, `wg-easy.env`), reconciled with
   master's wg-easy commits, plus the new `INIT_HOST` setting.
3. `WgEasyService` (Basic auth with the `INIT_PASSWORD` answer from OpenBao
   `apps/wg-easy`; the "rejected its admin password" 401 message),
   `WireguardController`, `InstalledService.appStatus()`, the install
   endpoint's allowlist and delegation.
4. The root CA mount and `GET /api/bootstrap/ca`.
5. Client: `RootGate`, `PreAuthScreens` (WakingScreen, UseDomainScreen),
   `useBootstrapStatus`, the router wiring, and the Welcome, VPN, Trust,
   Connect and Graduate steps with their tests.
6. AuthGuard's `/api/bootstrap` exemption and `sub === 'onboarding'` rejection.
7. The Tier 1 onboarding test's "authenticated visit renders the app, never an
   SSO redirect" invariant.

Retired: the Casdoor factory-login probe as the claimed/unclaimed detector and
its `claimedCached` latch; cookies set by the status check; the
handshake-based "tour open" rule; the `librepod/admin` owner account; the
"use my admin password for WireGuard" checkbox; the old spec and plan.

New: the onboarding record and setup code; OpenBao `system/` access and
policy; claim, resume and account endpoints; the reworked Casdoor admin
service; the finish hook in the SSO callback; `reset-onboarding`; the Claim
(code), Account, Resume and "not set up yet" screens; the "bring my own" path
and endpoint field; docs (README first-run section; `ui/CLAUDE.md` API
section; `ui/PRODUCT.md` onboarding copy).

## 13. Testing

- **Server unit:** code format and normalization; record creation with
  check-and-set; every state transition; claim retried after a crash between
  the Casdoor and OpenBao writes; the "changed outside LibrePod" 409; account
  create, keep and re-password; resume; finish on callback and its retry;
  guard refusal on wrong generation and after `finished`; the reset script.
- **API e2e (supertest, Casdoor and OpenBao faked):** open → claim → account →
  install → finish; wrong code; endpoints refused after `finished`; a reset
  reopens onboarding and invalidates old cookies.
- **Client:** RootGate's state × arrival matrix; both wizard paths; Resume;
  Account keep vs new password; the Connect fallback.
- **Tier 1 (Playwright):** the carried "never an SSO redirect" invariant. The
  shared Tier 1 server forces `finished` (it has no Casdoor), and a domain
  arrival in `finished` gets the app, so #215's second check ("the wizard
  renders for an unauthenticated visitor") cannot hold there; it moves to the
  client tests.
- **Manifests:** kustomize build + kubeconform for marketplace-ui, wg-easy and
  openbao.
- **Live dev check** — only with the user's go-ahead. Before it: confirm
  Casdoor's built-in admin is still `123` (earlier #215 testing may have
  changed it), wipe wg-easy's old data folder on NFS, and remove leftovers from
  the #215 era (e.g. a `marketplace-ui-admin-credential` Secret). Each step is
  confirmed with the user first.

## 14. Follow-ups (each its own spec or PR)

1. Connectivity page in Marketplace UI: add devices, switch VPN.
2. User management and password changes via the Casdoor SDK — including
   changing the admin password and updating every app that received it
   (wg-easy now), which otherwise drift apart.
3. Catalog installs defaulting any app's admin-password question to the admin
   password.
4. LibrePod OS: a pre-set setup code (sticker), `librepod reset-onboarding`
   wrapping the kubectl command, showing the code on the console, and
   tightening the firewall (it opens 6443, 10250, 1080 and 7400 to everyone).
5. "Also delete data" on uninstall (Retain volumes keep app data today).
6. LibrePort for remote ("away") access.
7. The mobile app as a second client of the same claim API.

## 15. Out of scope

- An https-only wizard.
- Rate-limiting setup-code attempts.
- Groups and roles.
- A separate flow per environment.
- Migrating existing installs — there are no devices in the field; rollout is
  big-bang (bootstrap release + OS pin together).

## Evidence (resolved from source, do not re-derive)

- **Casdoor v3.106.0:** `POST /api/login` is anonymous JSON (how the login page
  works) and sets a beego session cookie — the only auth `/api/set-password`
  accepts (form-encoded; rejects whitespace). `get-user` / `add-user` /
  `get-organization` / `add-organization` work with that session. Users must
  live in org `librepod` for the platform apps (app binding +
  `CheckLoginPermission`).
- **casdoor-sso-controller:** `CASDOOR_ADMIN_PASSWORD` is used only by its
  first-boot init container to mint the controller's own access key; changing
  the built-in admin password later does not affect it.
- **wg-easy v15.4.0:** every permission-gated `/api/*` route accepts
  `Authorization: Basic admin:<password>`; unattended setup runs only when
  `INIT_USERNAME`, `INIT_PASSWORD`, `INIT_HOST` and `INIT_PORT` are all
  non-empty and setup is not done, and later `INIT_*` changes have no effect;
  login, setup and password change reject passwords shorter than 12
  characters; `POST /api/client` requires `expiresAt` (`null` is fine) and
  returns `{ success, clientId }`.
- **wg-easy manifests:** `envFrom` lists the `wg-easy` ConfigMap first and the
  `wg-easy-settings` Secret second, so a Secret key wins.
- **OpenBao bootstrap:** policies are the `*.hcl` files of the overlay; the
  Job re-runs when `openbao.librepod/policies-version` changes (currently
  `"5"`); the `system/` KV v2 mount already exists (step-ca backups).
