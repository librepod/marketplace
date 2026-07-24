# vaultwarden SSO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire native OIDC single-sign-on to vaultwarden through the `casdoor-sso-controller`, with zero committed secrets.

**Architecture:** Add an `SSOClient` CR to vaultwarden's overlay — the controller provisions the Casdoor OIDC application and writes `SSO_CLIENT_ID`/`SSO_CLIENT_SECRET` into `Secret/vaultwarden-sso` in the vaultwarden namespace at runtime. The non-secret SSO settings (`SSO_AUTHORITY` = bare Casdoor issuer, scopes, toggles) are literal env vars in the ConfigMap; only the client id/secret are read from the controller's Secret via `secretKeyRef`. vaultwarden validates OIDC tokens itself, so the IngressRoute stays middleware-free.

**Tech Stack:** Kustomize (base/overlay), FluxCD GitOps, `SSOClient` CRD (`marketplace.librepod.org/v1alpha1`), Casdoor OIDC. vaultwarden image is already `1.36.0-alpine` (SSO ships in the default build since v1.35.0) — no image bump.

**Spec:** `docs/superpowers/specs/2026-07-24-marketplace-app-sso-rollout-design.md` §5.1
**Author guide:** `docs/sso-app-author-guide.md`
**App skill:** `.claude/skills/librepod-app` (conventions) and `.claude/skills/verify-app` (dev-cluster validation)

## Global Constraints

- **Scope confined to `apps/vaultwarden/` only** — this plan runs in a worktree alongside three sibling plans; touch no other app and no shared file.
- **Never hand-edit `catalog.yaml`** — CI (`publish-catalog.yaml`) regenerates it from `metadata.yaml` changes.
- `SSO_AUTHORITY` is the **bare issuer** (`https://sso.${BASE_DOMAIN}`, no `/.well-known/...`, no trailing slash) — vaultwarden appends discovery itself. Do NOT wire the controller's `issuer` output key (a discovery URL) to it.
- vaultwarden's OIDC redirect path is **`/identity/connect/oidc-signin`** (confirmed from upstream guides).
- `${BASE_DOMAIN}` in ConfigMap data is substituted by Flux `postBuild.substitute` (the existing `DOMAIN` line already relies on this); use plain `${BASE_DOMAIN}` with no `:-default`.

**Working directory for all commands:** `/home/alex/code/librepod/marketplace`. Work on a feature branch (e.g. `feat/vaultwarden-sso`); the worktree starts from `master`.

**Dev cluster:** `./librepod-dev.config` (gitignored). Pass `--kubeconfig ./librepod-dev.config` to every kubectl call.

---

### Task 1: Add the `SSOClient` CR to the overlay

**Files:**
- Create: `apps/vaultwarden/overlays/librepod/ssoclient.yaml`
- Modify: `apps/vaultwarden/overlays/librepod/kustomization.yaml` (register the CR in `resources:`)

**Interfaces:**
- Produces: `Secret/vaultwarden-sso` (namespace `vaultwarden`) with keys `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_ISSUER` — consumed by Task 2's `secretKeyRef`.

- [ ] **Step 1: Create the `SSOClient` CR**

Create `apps/vaultwarden/overlays/librepod/ssoclient.yaml`:

```yaml
# The casdoor-sso-controller reconciles this CR: it provisions the Casdoor
# OIDC Application (clientId "vaultwarden") and writes the client id/secret +
# issuer into Secret/vaultwarden-sso in this namespace. vaultwarden reads only
# SSO_CLIENT_ID/SSO_CLIENT_SECRET from that Secret (Task 2); SSO_ISSUER is the
# controller's discovery URL and is left unused — vaultwarden takes its issuer
# from the literal SSO_AUTHORITY env var instead (see Global Constraints).
apiVersion: marketplace.librepod.org/v1alpha1
kind: SSOClient
metadata:
  name: vaultwarden-sso
  namespace: vaultwarden
spec:
  clientId: vaultwarden
  organization: librepod
  redirectUris:
    - "https://vaultwarden.${BASE_DOMAIN}/identity/connect/oidc-signin"
  grantTypes: [authorization_code, refresh_token]
  tokenFormat: JWT
  expireInHours: 168
  output:
    secretName: vaultwarden-sso
    keys:
      clientId: SSO_CLIENT_ID
      clientSecret: SSO_CLIENT_SECRET
      issuer: SSO_ISSUER
  casdoorPolicy: retain
```

- [ ] **Step 2: Register it in the overlay kustomization**

In `apps/vaultwarden/overlays/librepod/kustomization.yaml`, add `- ssoclient.yaml` to the `resources:` list so it reads:

```yaml
resources:
- ../../base
- ingressroute.yaml
- ssoclient.yaml
```

- [ ] **Step 3: Build to verify the CR renders**

Run:
```bash
kustomize build apps/vaultwarden/overlays/librepod | grep -A3 "kind: SSOClient"
```
Expected: the `SSOClient` resource renders with `name: vaultwarden-sso`, `namespace: vaultwarden`, `clientId: vaultwarden`, and the `/identity/connect/oidc-signin` redirect URI.

- [ ] **Step 4: Commit**

```bash
git add apps/vaultwarden/overlays/librepod/ssoclient.yaml apps/vaultwarden/overlays/librepod/kustomization.yaml
git commit -m "feat(vaultwarden): add SSOClient CR for native OIDC SSO"
```

---

### Task 2: Wire vaultwarden to SSO (env vars + secretKeyRef)

Add the non-secret SSO env vars to the ConfigMap, and read the client id/secret from the controller's Secret.

**Files:**
- Modify: `apps/vaultwarden/base/vaultwarden.env` (append literal SSO vars)
- Modify: `apps/vaultwarden/base/deployment.yaml` (add `env:` secretKeyRef entries)

**Interfaces:**
- Consumes: `Secret/vaultwarden-sso` keys `SSO_CLIENT_ID`/`SSO_CLIENT_SECRET` produced by Task 1.

- [ ] **Step 1: Append the non-secret SSO env vars**

Append to `apps/vaultwarden/base/vaultwarden.env` (the file currently has 3 lines; do not remove them):

```
# --- SSO (OpenID Connect via casdoor-sso-controller) ---
SSO_ENABLED=true
SSO_AUTHORITY=https://sso.${BASE_DOMAIN}
SSO_SCOPES="openid email profile"
SSO_SIGNUPS_MATCH_EMAIL=true
SSO_PKCE=true
```

(`SSO_AUTHORITY` is the bare issuer; `${BASE_DOMAIN}` is substituted by Flux at deploy time, same as the existing `DOMAIN` line.)

- [ ] **Step 2: Add the secretKeyRef env entries to the Deployment**

In `apps/vaultwarden/base/deployment.yaml`, add an `env:` block to the `vaultwarden` container, immediately after the existing `envFrom:` block. The container spec becomes:

```yaml
        - name: vaultwarden
          image: vaultwarden/server
          imagePullPolicy: IfNotPresent
          envFrom:
            - configMapRef:
                name: vaultwarden
          env:
            - name: SSO_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: vaultwarden-sso
                  key: SSO_CLIENT_ID
            - name: SSO_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: vaultwarden-sso
                  key: SSO_CLIENT_SECRET
          volumeMounts:
            - name: data
              mountPath: /data
```

(Individual `env:` entries take precedence over `envFrom`, so the secret-backed values win even though both could nominally carry them. Leave `envFrom` and everything below it unchanged.)

- [ ] **Step 3: Build to verify both changes render**

Run:
```bash
kustomize build apps/vaultwarden/overlays/librepod > /tmp/vw-rendered.yaml
grep -E "SSO_ENABLED|SSO_AUTHORITY|SSO_SCOPES|SSO_PKCE" /tmp/vw-rendered.yaml   # ConfigMap: 4 literal vars
grep -A2 "SSO_CLIENT_ID" /tmp/vw-rendered.yaml                                    # Deployment: secretKeyRef
```
Expected: the four literal SSO vars appear in the generated ConfigMap, and the Deployment shows `SSO_CLIENT_ID`/`SSO_CLIENT_SECRET` `secretKeyRef`s pointing at `vaultwarden-sso`.

- [ ] **Step 4: Confirm the IngressRoute has no oauth2 middlewares**

Run:
```bash
grep -i "oauth2\|middleware" apps/vaultwarden/overlays/librepod/ingressroute.yaml || echo "clean (native OIDC — no forward-auth)"
```
Expected: `clean (native OIDC — no forward-auth)`. vaultwarden validates OIDC itself, so no change is needed here.

- [ ] **Step 5: Commit**

```bash
git add apps/vaultwarden/base/vaultwarden.env apps/vaultwarden/base/deployment.yaml
git commit -m "feat(vaultwarden): enable OIDC SSO env + secretKeyRef to controller Secret"
```

---

### Task 3: Declare the `casdoor-sso` dependency in `metadata.yaml`

Order vaultwarden's Flux Kustomization after `casdoor-sso` so the `SSOClient` CRD + controller exist before the overlay (which contains the CR) is applied, and advertise the dependency.

**Files:**
- Modify: `apps/vaultwarden/metadata.yaml`

- [ ] **Step 1: Add the `SSOProvider` dependency**

In `apps/vaultwarden/metadata.yaml`, add an entry to `spec.dependencies.required` (after the existing `StorageClass` entry):

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

- [ ] **Step 2: Add `dependsOn: casdoor-sso` to the release template**

In the `templates.release` block, the `spec:` currently begins with `interval: 10m`. Insert a `dependsOn:` list as the first field under `spec:`:

```yaml
      spec:
        dependsOn:
          - name: casdoor-sso
        interval: 10m
        targetNamespace: vaultwarden
```

(Leave the rest of the release template — `sourceRef`, `path`, `prune`, `wait`, `postBuild` — unchanged.)

- [ ] **Step 3: Verify**

Run:
```bash
grep -n "SSOProvider\|dependsOn\|casdoor-sso" apps/vaultwarden/metadata.yaml
```
Expected: one `SSOProvider` line and a `dependsOn`/`casdoor-sso` pair.

- [ ] **Step 4: Commit**

```bash
git add apps/vaultwarden/metadata.yaml
git commit -m "feat(vaultwarden): depend on casdoor-sso for OIDC provisioning"
```

---

### Task 4: Validate locally + deploy to librepod-dev (runbook)

Manifest validation is local; the SSO end-to-end check runs on the dev cluster. No new commits in this task.

- [ ] **Step 1: Render + kubeconform the full overlay**

Run:
```bash
kustomize build apps/vaultwarden/overlays/librepod \
  | kubeconform \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
      -strict -summary -ignore-missing-schemas
```
Expected: `Summary: ... valid: N ... invalid: 0`. The `SSOClient` resource has no public schema, so it shows as skipped (the `-ignore-missing-schemas` flag keeps that from failing the run); all standard resources validate.

- [ ] **Step 2: Confirm the controller is healthy on dev**

Run:
```bash
KC=./librepod-dev.config
kubectl --kubeconfig $KC get ssoclient -A | head
kubectl --kubeconfig $KC -n casdoor-sso-controller get deploy
```
Expected: the CRD is installed and the controller pod is `Ready` (if not, stop — SSO wiring can't be validated without it).

- [ ] **Step 3: Apply the overlay to dev (substituting BASE_DOMAIN)**

Run:
```bash
KC=./librepod-dev.config
export BASE_DOMAIN=librepod.dev
kustomize build apps/vaultwarden/overlays/librepod \
  | envsubst '${BASE_DOMAIN}' \
  | kubectl --kubeconfig $KC apply -f -
kubectl --kubeconfig $KC -n vaultwarden rollout status deploy/vaultwarden --timeout=120s
```
Expected: resources apply; deployment reaches `Running`. On very first apply the pod may briefly wait in `CreateContainerConfigError` until the controller reconciles the `SSOClient` and writes `Secret/vaultwarden-sso` — it self-heals within seconds (restart if needed).

- [ ] **Step 4: Verify the SSOClient reconciled and the Secret exists**

Run:
```bash
KC=./librepod-dev.config
kubectl --kubeconfig $KC -n vaultwarden get ssoclient vaultwarden-sso
kubectl --kubeconfig $KC -n vaultwarden get secret vaultwarden-sso -o jsonpath='{.data}' && echo
```
Expected: `vaultwarden-sso` shows `Phase=Ready` (condition `Ready=True`), and the Secret has three keys (`SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_ISSUER`).

- [ ] **Step 5: Verify OIDC login end-to-end**

Open `https://vaultwarden.<dev-domain>/` (via the cluster's ingress / tailnet) and complete an OIDC login through Casdoor. Confirm a user is created/matched. (If you prefer the verify-app skill flow, use `.claude/skills/verify-app`.)

Expected: redirect to Casdoor → consent → back to vaultwarden signed in.

- [ ] **Step 6: Record results; no commit**

Note outcomes in the PR description. File any follow-ups (e.g. the known mobile-OIDC-redirect caveat) as issues. **Do not edit `catalog.yaml`** — CI regenerates it from the `metadata.yaml` change.

---

## Self-review notes (plan author)

- **Spec coverage (§5.1):** `SSOClient` CR + redirect `/identity/connect/oidc-signin` → Task 1. Literal SSO env + bare `SSO_AUTHORITY` → Task 2 Step 1. `secretKeyRef` id/secret → Task 2 Step 2. IngressRoute middleware-free → Task 2 Step 4. `dependsOn: casdoor-sso` + `SSOProvider` dependency → Task 3. No image bump needed (1.36.0 already ships SSO). Validation → Task 4.
- **Bare-issuer invariant:** `SSO_AUTHORITY=https://sso.${BASE_DOMAIN}` (literal, Task 2); the controller's `issuer` output key maps to `SSO_ISSUER` (Task 1) but is intentionally NOT consumed — consistent with the design's §3 cross-cutting note.
- **No cross-app edits:** all paths under `apps/vaultwarden/`. `catalog.yaml` untouched.
- **Gotchas carried forward:** `SSO_SIGNUPS_MATCH_EMAIL=true` (prevent email-spoof takeover); SSO gates login only (vault master passwords remain); keep ≥ 1.36.0; known mobile-client OIDC caveat to watch in Task 4 Step 5.
