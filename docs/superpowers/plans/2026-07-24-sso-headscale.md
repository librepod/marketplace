# headscale SSO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire native OIDC to Headscale (self-hosted Tailscale control server) through the `casdoor-sso-controller`, so a user authorizing their device at `tailscale up` is redirected through Casdoor.

**Architecture:** Headscale's OIDC authenticates a **device joining the tailnet** (not a user logging into a web UI). The `oidc:` config block already exists as a commented TODO in `base/config.yaml` using `${OIDC_CLIENT_ID}`/`${OIDC_CLIENT_SECRET}` Flux substitution. Add an `SSOClient` CR — the controller provisions the Casdoor application and writes those values into `Secret/headscale-sso` **in the `flux-system` namespace** (Headscale's config file cannot read env, so the values are consumed by Flux `substituteFrom` at render time, not by the pod at runtime). The issuer is the bare `https://sso.${BASE_DOMAIN}` (Headscale does OIDC discovery itself); the OIDC callback is on `${FRP_DOMAIN}` (publicly reachable before the node joins the VPN).

**Tech Stack:** Kustomize (base/overlay + headplane & frp-upstreams components), FluxCD GitOps, `SSOClient` CRD (`marketplace.librepod.org/v1alpha1`), Casdoor OIDC. Image is `headscale/headscale` tag `v0.28.0` — no bump.

**Spec:** `docs/superpowers/specs/2026-07-24-marketplace-app-sso-rollout-design.md` §5.4
**Upstream manual:** <https://headscale.net/stable/ref/oidc/#configuration>
**Author guide:** `docs/sso-app-author-guide.md`
**App skill:** `.claude/skills/librepod-app` (conventions) and `.claude/skills/verify-app` (dev-cluster validation)

## Global Constraints

- **Scope confined to `apps/headscale/` only** — runs in a worktree alongside three sibling plans; touch no other app and no shared file.
- **Never hand-edit `catalog.yaml`** — CI regenerates it from `metadata.yaml`.
- `oidc.issuer` is the **bare issuer** (`https://sso.${BASE_DOMAIN}`) — Headscale appends discovery itself. Not taken from the controller's `issuer` key.
- The OIDC redirect/callback is **`https://headscale.${FRP_DOMAIN}/oidc/callback`** — must be publicly reachable (FRP tunnel), because a Tailscale client hits it *before* joining the VPN. `${FRP_DOMAIN}` is already a Flux substitute var.
- `${OIDC_CLIENT_ID}`/`${OIDC_CLIENT_SECRET}` in `config.yaml` are resolved by Flux `substituteFrom` from `Secret/headscale-sso` in `flux-system`. This is the **config-file shape** (unlike the env-var apps), so the controller writes that Secret to `flux-system`, not to the `headscale` namespace.

**Working directory:** `/home/alex/code/librepod/marketplace`. Feature branch (e.g. `feat/headscale-sso`); worktree starts from `master`.

**Dev cluster:** `./librepod-dev.config` (gitignored). Pass `--kubeconfig ./librepod-dev.config` to every kubectl call.

---

### Task 1: Add the `SSOClient` CR (output to `flux-system`)

**Files:**
- Create: `apps/headscale/overlays/librepod/ssoclient.yaml`
- Modify: `apps/headscale/overlays/librepod/kustomization.yaml` (register the CR in `resources:`)

**Interfaces:**
- Produces: `Secret/headscale-sso` in **namespace `flux-system`** with keys `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ISSUER` — consumed by Flux `substituteFrom` (Task 3) into `config.yaml` (Task 2).

- [ ] **Step 1: Create the `SSOClient` CR**

Create `apps/headscale/overlays/librepod/ssoclient.yaml`:

```yaml
# The casdoor-sso-controller reconciles this CR: it provisions the Casdoor
# OIDC application (clientId "headscale") and writes the client id/secret into
# Secret/headscale-sso in the FLUX-SYSTEM namespace. Headscale cannot read
# these from env (its oidc config is a YAML file), so Flux substituteFrom
# (Task 3) reads this Secret and bakes the values into config.yaml at render
# time. OIDC_ISSUER is the controller's discovery URL and is left unused —
# headscale takes its issuer from the literal oidc.issuer below.
apiVersion: marketplace.librepod.org/v1alpha1
kind: SSOClient
metadata:
  name: headscale-sso
  namespace: headscale
spec:
  clientId: headscale
  organization: librepod
  redirectUris:
    - "https://headscale.${FRP_DOMAIN}/oidc/callback"
  grantTypes: [authorization_code, refresh_token]
  tokenFormat: JWT
  expireInHours: 168
  output:
    secretName: headscale-sso
    secretNamespace: flux-system
    keys:
      clientId: OIDC_CLIENT_ID
      clientSecret: OIDC_CLIENT_SECRET
      issuer: OIDC_ISSUER
  casdoorPolicy: retain
```

- [ ] **Step 2: Register it in the overlay kustomization**

In `apps/headscale/overlays/librepod/kustomization.yaml`, add `- ssoclient.yaml` to the `resources:` list (after `- ingressroute.yaml`):

```yaml
resources:
- ../../base
- ../../components/headplane
- ../../components/frp-upstreams
- ingressroute.yaml
- cors-middleware.yaml
- ssoclient.yaml
```

(Confirm the exact existing `resources:` order first — preserve all current entries, append `- ssoclient.yaml`.)

- [ ] **Step 3: Build to verify the CR renders**

Run:
```bash
kustomize build apps/headscale/overlays/librepod | grep -A4 "kind: SSOClient"
```
Expected: `SSOClient` renders with `name: headscale-sso`, `clientId: headscale`, `secretNamespace: flux-system`, redirect URI `https://headscale.${FRP_DOMAIN}/oidc/callback`.

- [ ] **Step 4: Commit**

```bash
git add apps/headscale/overlays/librepod/ssoclient.yaml apps/headscale/overlays/librepod/kustomization.yaml
git commit -m "feat(headscale): add SSOClient CR (output to flux-system) for OIDC"
```

---

### Task 2: Activate the `oidc:` block in `config.yaml`

The block is already present as a commented TODO (lines ~87-94). Uncomment it and add PKCE + the email-verified toggle.

**Files:**
- Modify: `apps/headscale/base/config.yaml` (lines ~87-94)

- [ ] **Step 1: Replace the commented oidc block with the active one**

In `apps/headscale/base/config.yaml`, replace this commented block:

```yaml
# OIDC single sign-on (native headscale support — no oauth2-proxy needed).
# Disabled for initial verification — re-enable after registering Casdoor client
# and mounting step-ca root CA for TLS trust.
# oidc:
#   issuer: https://sso.${BASE_DOMAIN}
#   client_id: ${OIDC_CLIENT_ID}
#   client_secret: ${OIDC_CLIENT_SECRET}
#   scope: ["openid", "profile", "email"]
```

with:

```yaml
# OIDC single sign-on (native headscale support — no oauth2-proxy needed).
# client_id/client_secret are provisioned by casdoor-sso-controller into
# Secret/headscale-sso (flux-system) and substituted here by Flux.
oidc:
  issuer: https://sso.${BASE_DOMAIN}
  client_id: ${OIDC_CLIENT_ID}
  client_secret: ${OIDC_CLIENT_SECRET}
  scope: ["openid", "profile", "email"]
  pkce:
    enabled: true
  email_verified_required: false
```

(`issuer` is bare — Headscale appends `/.well-known/openid-configuration`. `email_verified_required: false` pending confirmation that Casdoor sets `email_verified`; flip to `true` later if it does.)

- [ ] **Step 2: Build to confirm the block is active and `${...}` survive**

Run:
```bash
kustomize build apps/headscale/overlays/librepod > /tmp/hs-rendered.yaml
grep -A8 "^oidc:" /tmp/hs-rendered.yaml
```
Expected: an active `oidc:` block with `issuer: https://sso.${BASE_DOMAIN}`, `client_id: ${OIDC_CLIENT_ID}`, `client_secret: ${OIDC_CLIENT_SECRET}`, `pkce.enabled: true`. (The `${...}` are NOT resolved by `kustomize build` alone — Flux resolves them at deploy time. That is expected here.)

- [ ] **Step 3: Commit**

```bash
git add apps/headscale/base/config.yaml
git commit -m "feat(headscale): enable native OIDC (issuer, PKCE, controller-provisioned client creds)"
```

---

### Task 3: Wire Flux `substituteFrom` + dependency in `metadata.yaml`

The release template already has commented TODOs for exactly this. Activate them: read the controller's `headscale-sso` Secret via `substituteFrom`, order after `casdoor-sso`, and advertise the dependency.

**Files:**
- Modify: `apps/headscale/metadata.yaml`

- [ ] **Step 1: Add `substituteFrom` to the release `postBuild`**

In the `templates.release` block, the `postBuild:` currently is:

```yaml
        postBuild:
          substitute:
            BASE_DOMAIN: "${BASE_DOMAIN}"
            FRP_DOMAIN: "${FRP_DOMAIN}"
          # TODO: Uncomment when Casdoor provisioning logic auto-creates OIDC clients per app
          #   OIDC_CLIENT_ID: "${OIDC_CLIENT_ID}"
          # substituteFrom:
          #   - kind: Secret
          #     name: headscale-config
```

Replace it with (drop the commented `OIDC_CLIENT_ID` substitute line — it comes from the controller Secret, not a user param — and add the `substituteFrom`):

```yaml
        postBuild:
          substitute:
            BASE_DOMAIN: "${BASE_DOMAIN}"
            FRP_DOMAIN: "${FRP_DOMAIN}"
          substituteFrom:
            - kind: Secret
              name: headscale-sso
```

(`headscale-sso` lives in `flux-system`, which is where this Kustomization runs, so `substituteFrom` finds it by default. The controller writes `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` there (Task 1).)

- [ ] **Step 2: Add `casdoor-sso` to the release `dependsOn`**

In the same release `spec:`, the `dependsOn:` currently lists `traefik` and `storage`. Add `casdoor-sso` so the `SSOClient` CRD/controller exist (and the `headscale-sso` Secret is reconciled) before this Kustomization renders `config.yaml`:

```yaml
        dependsOn:
          - name: traefik
          - name: storage
          - name: casdoor-sso
```

- [ ] **Step 3: Add the `SSOProvider` dependency**

In `spec.dependencies.required`, replace the commented `App: casdoor` TODO with an `SSOProvider` entry:

```yaml
  dependencies:
    required:
      - kind: IngressController
        description: "Traefik (provided by bootstrap)"
      - kind: StorageClass
        description: "nfs-client (provided by bootstrap)"
      - kind: SSOProvider
        description: "Casdoor SSO (provided by casdoor-sso-controller)"
```

- [ ] **Step 4: Leave the user-param/secret TODOs commented**

The `OIDC_CLIENT_ID` param and `OIDC_CLIENT_SECRET` secret TODOs (in `params:`/`secrets:`) stay commented — the controller provisions these now, so they are NOT user-supplied. Do not uncomment them.

- [ ] **Step 5: Verify**

Run:
```bash
grep -n "substituteFrom\|headscale-sso\|name: casdoor-sso\|SSOProvider" apps/headscale/metadata.yaml
```
Expected: the `substituteFrom`/`headscale-sso`, `casdoor-sso` dependsOn, and `SSOProvider` lines are all present.

- [ ] **Step 6: Commit**

```bash
git add apps/headscale/metadata.yaml
git commit -m "feat(headscale): substituteFrom controller SSO Secret; depend on casdoor-sso"
```

---

### Task 4: Validate locally

No new commits in this task.

- [ ] **Step 1: Render + kubeconform the full overlay**

Run:
```bash
kustomize build apps/headscale/overlays/librepod \
  | kubeconform \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
      -strict -summary -ignore-missing-schemas
```
Expected: `Summary: ... invalid: 0`. (`SSOClient` skipped — no public schema.)

- [ ] **Step 2: Confirm Flux would resolve every `${...}` in the rendered config**

Run:
```bash
kustomize build apps/headscale/overlays/librepod | grep -oE '\$\{[A-Z_]+\}' | sort -u
```
Expected: only `${BASE_DOMAIN}`, `${FRP_DOMAIN}`, `${OIDC_CLIENT_ID}`, `${OIDC_CLIENT_SECRET}` — all of which are covered by the `substitute` map (`BASE_DOMAIN`, `FRP_DOMAIN`) or `substituteFrom` (`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`). No unresolved/unknown variable.

---

### Task 5: Deploy to librepod-dev + verify OIDC device-join (runbook)

No new commits unless Task 5 Step 2 (CA trust) requires one.

- [ ] **Step 1: Confirm the controller is healthy and FRP is up**

Run:
```bash
KC=./librepod-dev.config
kubectl --kubeconfig $KC get ssoclient -A | head
kubectl --kubeconfig $KC -n casdoor-sso-controller get deploy
kubectl --kubeconfig $KC -n headscale get frpclient/frpupstream 2>/dev/null || kubectl --kubeconfig $KC get frpclient -A 2>/dev/null | head
```
Expected: CRD installed, controller `Ready`, and the FRP upstream that exposes `headscale.${FRP_DOMAIN}` is present/reconciled.

- [ ] **Step 2: Apply the overlay to dev (substituting BASE_DOMAIN + FRP_DOMAIN)**

Run:
```bash
KC=./librepod-dev.config
# Set the dev cluster's real values (FRP_DOMAIN is the public tunnel host):
export BASE_DOMAIN=librepod.dev
export FRP_DOMAIN=<dev FRP tunnel domain>     # confirm from the live headscale SSOClient/metadata
kustomize build apps/headscale/overlays/librepod \
  | envsubst '${BASE_DOMAIN} ${FRP_DOMAIN}' \
  | kubectl --kubeconfig $KC apply -f -
kubectl --kubeconfig $KC -n headscale rollout status deploy/headscale --timeout=180s
```
Expected: resources apply; headscale reaches `Running`. On the very first apply the `headscale-sso` Secret may not exist yet (controller hasn't reconciled the CR) → Flux leaves `${OIDC_CLIENT_ID}` literal in `config.yaml` and retries; it self-heals on the next interval once the controller writes the Secret. If `config.yaml` still shows a literal `${OIDC_CLIENT_ID}`, force a reconcile and re-roll the pod (Step 4).

- [ ] **Step 3: Verify TLS trust for the Casdoor issuer (DECISION POINT)**

Headscale must reach `https://sso.${BASE_DOMAIN}/.well-known/openid-configuration` over TLS. From the headscale pod:

Run:
```bash
KC=./librepod-dev.config
kubectl --kubeconfig $KC -n headscale exec deploy/headscale -- \
  wget -qO- --timeout=10 https://sso.${BASE_DOMAIN}/.well-known/openid-configuration | head -c 120
```
- If it returns JSON (discovery document) → Casdoor's cert is already trusted (public CA). **Skip to Step 4.**
- If it fails with an unknown-CA / certificate error → Casdoor uses a step-ca-issued cert. Mount the step-ca root CA into the headscale container: find the root CA in the `step-certificates` namespace (`kubectl --kubeconfig $KC get secret,configmap -n step-certificates | grep -i 'ca\|root'`), add a `volumes:` entry mounting it and a `volumeMounts:` to `/etc/ssl/certs/step-ca-root.crt`, and set env `SSL_CERT_FILE=/etc/ssl/certs/step-ca-root.crt` (or append to the system bundle). Re-apply, re-roll, and re-run this step until discovery returns JSON. Commit the CA-mount change.

- [ ] **Step 4: Verify the SSOClient reconciled and the Secret exists**

Run:
```bash
KC=./librepod-dev.config
kubectl --kubeconfig $KC -n headscale get ssoclient headscale-sso
kubectl --kubeconfig $KC -n flux-system get secret headscale-sso -o jsonpath='{.data}' && echo
kubectl --kubeconfig $KC -n headscale exec deploy/headscale -- grep -A3 "^oidc:" /etc/headscale/config.yaml
```
Expected: `Phase=Ready`; the `flux-system/headscale-sso` Secret has `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`/`OIDC_ISSUER`; and the live `config.yaml` shows the **resolved** `client_id`/`client_secret` (no literal `${...}`). If `config.yaml` still shows a literal, force Flux to re-render:

```bash
kubectl --kubeconfig $KC -n flux-system annotate kustomization marketplace-headscale fluxcd.io/reconcile=disabled --overwrite
kubectl --kubeconfig $KC -n flux-system annotate kustomization marketplace-headscale fluxcd.io/reconcile=enabled --overwrite
# or: flux --kubeconfig $KC reconcile kustomization marketplace-headscale --with-source
kubectl --kubeconfig $KC -n headscale rollout restart deploy/headscale
```

- [ ] **Step 5: Verify the OIDC device-join flow end-to-end**

On a client device, run `tailscale up --login-server https://headscale.${FRP_DOMAIN}`. Headscale should redirect the browser to Casdoor for approval, then register the node.

Expected: browser → Casdoor login/consent → node appears in `headscale nodes list`.

- [ ] **Step 6: Verify the `preferred_username` claim is compatible**

Headscale requires the username (`preferred_username` claim) to be ≥2 chars, start with a letter, and contain at most one `@`. Confirm what Casdoor sends:

Run:
```bash
KC=./librepod-dev.config
# Decode the id_token from a test login (or inspect the userinfo endpoint) and check preferred_username.
```
If Casdoor's `preferred_username` violates the pattern, the join fails with a username error — configure Casdoor (or the SSOClient `applicationOverrides`) to send a compliant value. (Headscale OIDC limitation: groups also cannot be used in policy rules.)

- [ ] **Step 7: Record results; commit only if Step 3 added a CA mount**

Note outcomes in the PR description. **Do not edit `catalog.yaml`** — CI regenerates it from the `metadata.yaml` change.

---

## Self-review notes (plan author)

- **Spec coverage (§5.4):** `SSOClient` CR + redirect on `${FRP_DOMAIN}/oidc/callback` + output to `flux-system` → Task 1. Active `oidc:` block with bare issuer + PKCE + `email_verified_required` → Task 2. Flux `substituteFrom` + `dependsOn: casdoor-sso` + `SSOProvider` → Task 3. Validation → Task 4. Deploy + TLS-trust decision + device-join + `preferred_username` → Task 5.
- **Secret-namespace choice:** `flux-system` (not `headscale`) because Headscale's config is a YAML file consumed via Flux `substituteFrom`, and `substituteFrom` reads in the Kustomization's namespace (`flux-system`). This differs from the env-var apps (vaultwarden/litellm/seafile) where the pod reads a Secret in its own namespace — called out in Task 1.
- **Bare-issuer invariant:** `oidc.issuer: https://sso.${BASE_DOMAIN}` literal (Task 2); controller's `issuer` output key maps to `OIDC_ISSUER` (Task 1) but is unused — consistent with the design's §3 note.
- **First-render transient:** on first apply the controller hasn't yet written `headscale-sso`, so Flux leaves `${OIDC_CLIENT_ID}` literal and retries; self-heals on next interval (Task 5 Step 2/4).
- **No cross-app edits:** all paths under `apps/headscale/`. `catalog.yaml` untouched.
- **Open items carried from the spec:** (1) TLS trust for `sso.${BASE_DOMAIN}` — verification-led in Task 5 Step 3 (mount step-ca root CA only if the cert isn't publicly trusted); (2) confirm Casdoor's `preferred_username` satisfies Headscale's username pattern (Task 5 Step 6); (3) `email_verified_required` defaulting to `false` until Casdoor's `email_verified` claim is confirmed.
- **Out of scope:** the Headplane admin UI has its own commented `oidc:` block (`components/headplane/config.yaml`); wiring it is a separate follow-up, not part of this plan (the user-linked reference covers Headscale core OIDC).
