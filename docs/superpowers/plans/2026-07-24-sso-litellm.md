# litellm SSO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire native OIDC single-sign-on to the LiteLLM admin UI through the `casdoor-sso-controller`, with zero committed secrets.

**Architecture:** Add an `SSOClient` CR to litellm's overlay — the controller provisions the Casdoor OIDC application and writes `GENERIC_CLIENT_ID`/`GENERIC_CLIENT_SECRET` into `Secret/litellm-sso` at runtime. The non-secret SSO settings (`GENERIC_*_ENDPOINT` Casdoor URLs and `PROXY_BASE_URL`) are literal env vars in the `litellm-env` ConfigMap; only the client id/secret are read from the controller's Secret via `secretKeyRef`. LiteLLM validates OIDC itself, so the IngressRoute stays middleware-free. litellm is a **Kustomize** app (raw `deployment.yaml`, no HelmRelease).

**Tech Stack:** Kustomize (base/overlay + postgres component), FluxCD GitOps, `SSOClient` CRD (`marketplace.librepod.org/v1alpha1`), Casdoor OIDC. Image is already `v1.81.9-stable.patch.1` (≥ v1.76.0, so SSO is free for ≤5 users) — no image bump.

**Spec:** `docs/superpowers/specs/2026-07-24-marketplace-app-sso-rollout-design.md` §5.2
**Author guide:** `docs/sso-app-author-guide.md`
**App skill:** `.claude/skills/librepod-app` (conventions) and `.claude/skills/verify-app` (dev-cluster validation)

## Global Constraints

- **Scope confined to `apps/litellm/` only** — runs in a worktree alongside three sibling plans; touch no other app and no shared file.
- **Never hand-edit `catalog.yaml`** — CI regenerates it from `metadata.yaml`.
- The `GENERIC_*_ENDPOINT` values and `PROXY_BASE_URL` are **literal** env values carrying `${BASE_DOMAIN}` (substituted by Flux at deploy time, same as the existing ConfigMap vars). They are NOT taken from the controller's `issuer` key (litellm wants specific endpoint URLs, not a discovery URL).
- `PROXY_BASE_URL` MUST include the protocol: `https://litellm.${BASE_DOMAIN}` (a bare host causes `redirect_uri` errors).
- LiteLLM's SSO callback is `<PROXY_BASE_URL>/sso/callback` → `https://litellm.${BASE_DOMAIN}/sso/callback`.

**Working directory:** `/home/alex/code/librepod/marketplace`. Feature branch (e.g. `feat/litellm-sso`); worktree starts from `master`.

**Dev cluster:** `./librepod-dev.config` (gitignored). Pass `--kubeconfig ./librepod-dev.config` to every kubectl call.

---

### Prerequisite: Restore a working baseline build (pre-existing breakage)

The overlay currently references `../../components/gluetun`, but **that component was never created** (no git history, not present anywhere in the repo), so `kustomize build apps/litellm/overlays/librepod` **fails today**. This blocks all SSO validation. The reference is dead and unrelated to SSO; removing it makes the build match reality (litellm has no gluetun egress today).

**Files:**
- Modify: `apps/litellm/overlays/librepod/kustomization.yaml`

- [ ] **Step 1: Confirm the baseline build fails**

Run:
```bash
kustomize build apps/litellm/overlays/librepod >/dev/null
```
Expected: error `... components/gluetun ... no such file or directory`.

- [ ] **Step 2: Remove the dangling gluetun component reference**

In `apps/litellm/overlays/librepod/kustomization.yaml`, delete the `- ../../components/gluetun` line so `components:` reads:

```yaml
components:
- ../../components/postgres
```

- [ ] **Step 3: Verify the build now succeeds**

Run:
```bash
kustomize build apps/litellm/overlays/librepod >/tmp/ll-rendered.yaml && echo "BUILD OK ($(grep -c 'kind:' /tmp/ll-rendered.yaml) resources)"
```
Expected: `BUILD OK (...)`.

- [ ] **Step 4: Commit**

```bash
git add apps/litellm/overlays/librepod/kustomization.yaml
git commit -m "fix(litellm): drop dangling gluetun component reference (never existed; unblocks kustomize build)"
```

> **Note for the PR description:** gluetun (LLM-API egress VPN) was referenced but never implemented. If routing LLM provider traffic through a VPN is desired, that is a **separate** task — file it as an issue; do not block SSO on it.

---

### Task 1: Add the `SSOClient` CR to the overlay

**Files:**
- Create: `apps/litellm/overlays/librepod/ssoclient.yaml`
- Modify: `apps/litellm/overlays/librepod/kustomization.yaml` (register the CR in `resources:`)

**Interfaces:**
- Produces: `Secret/litellm-sso` (namespace `litellm`) with keys `GENERIC_CLIENT_ID`, `GENERIC_CLIENT_SECRET`, `GENERIC_ISSUER` — consumed by Task 2's `secretKeyRef`.

- [ ] **Step 1: Create the `SSOClient` CR**

Create `apps/litellm/overlays/librepod/ssoclient.yaml`:

```yaml
# The casdoor-sso-controller reconciles this CR: it provisions the Casdoor
# OIDC Application (clientId "litellm") and writes the client id/secret into
# Secret/litellm-sso in this namespace. LiteLLM reads GENERIC_CLIENT_ID/
# GENERIC_CLIENT_SECRET from that Secret (Task 2); GENERIC_ISSUER is the
# controller's discovery URL and is left unused — litellm takes its endpoints
# from the literal GENERIC_*_ENDPOINT env vars (see Global Constraints).
apiVersion: marketplace.librepod.org/v1alpha1
kind: SSOClient
metadata:
  name: litellm-sso
  namespace: litellm
spec:
  clientId: litellm
  organization: librepod
  redirectUris:
    - "https://litellm.${BASE_DOMAIN}/sso/callback"
  grantTypes: [authorization_code, refresh_token]
  tokenFormat: JWT
  expireInHours: 168
  output:
    secretName: litellm-sso
    keys:
      clientId: GENERIC_CLIENT_ID
      clientSecret: GENERIC_CLIENT_SECRET
      issuer: GENERIC_ISSUER
  casdoorPolicy: retain
```

- [ ] **Step 2: Register it in the overlay kustomization**

In `apps/litellm/overlays/librepod/kustomization.yaml`, add `- ssoclient.yaml` to the `resources:` list (after `- ingressroute.yaml`):

```yaml
resources:
- ../../base
- ingressroute.yaml
- ssoclient.yaml
```

- [ ] **Step 3: Build to verify the CR renders**

Run:
```bash
kustomize build apps/litellm/overlays/librepod | grep -A3 "kind: SSOClient"
```
Expected: the `SSOClient` renders with `name: litellm-sso`, `namespace: litellm`, `clientId: litellm`, and the `/sso/callback` redirect URI.

- [ ] **Step 4: Commit**

```bash
git add apps/litellm/overlays/librepod/ssoclient.yaml apps/litellm/overlays/librepod/kustomization.yaml
git commit -m "feat(litellm): add SSOClient CR for native OIDC SSO"
```

---

### Task 2: Wire litellm to SSO (env vars + secretKeyRef)

Add the non-secret SSO endpoints + `PROXY_BASE_URL` to the ConfigMap, and read the client id/secret from the controller's Secret.

**Files:**
- Modify: `apps/litellm/base/litellm.env` (append literal SSO vars)
- Modify: `apps/litellm/base/deployment.yaml` (add `env:` secretKeyRef entries)

**Interfaces:**
- Consumes: `Secret/litellm-sso` keys `GENERIC_CLIENT_ID`/`GENERIC_CLIENT_SECRET` produced by Task 1.

- [ ] **Step 1: Append the non-secret SSO env vars**

Append to `apps/litellm/base/litellm.env`:

```
# --- SSO (OIDC admin-UI login via casdoor-sso-controller) ---
GENERIC_AUTHORIZATION_ENDPOINT=https://sso.${BASE_DOMAIN}/login/oauth/authorize
GENERIC_TOKEN_ENDPOINT=https://sso.${BASE_DOMAIN}/login/oauth/access_token
GENERIC_USERINFO_ENDPOINT=https://sso.${BASE_DOMAIN}/api/userinfo
PROXY_BASE_URL=https://litellm.${BASE_DOMAIN}
```

(Do not modify the existing `LITELLM_MASTER_KEY` / `LITELM_SALT_KEY` / DB lines — see Open items.)

- [ ] **Step 2: Add the secretKeyRef env entries to the Deployment**

In `apps/litellm/base/deployment.yaml`, add an `env:` block to the `litellm` container immediately after the existing `envFrom:` block. The container spec becomes:

```yaml
        - name: litellm
          image: litellm/litellm
          imagePullPolicy: IfNotPresent
          args:
            - "--config"
            - "/app/config.yaml"
          envFrom:
            - configMapRef:
                name: litellm-env
          env:
            - name: GENERIC_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: litellm-sso
                  key: GENERIC_CLIENT_ID
            - name: GENERIC_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: litellm-sso
                  key: GENERIC_CLIENT_SECRET
          ports:
            - name: http
              containerPort: 4000
              protocol: TCP
```

(Leave everything below `ports:` unchanged.)

- [ ] **Step 3: Build to verify both changes render**

Run:
```bash
kustomize build apps/litellm/overlays/librepod > /tmp/ll-rendered.yaml
grep -E "GENERIC_AUTHORIZATION_ENDPOINT|GENERIC_TOKEN_ENDPOINT|GENERIC_USERINFO_ENDPOINT|PROXY_BASE_URL" /tmp/ll-rendered.yaml
grep -A2 "GENERIC_CLIENT_ID" /tmp/ll-rendered.yaml
```
Expected: the four literal vars appear in the generated `litellm-env` ConfigMap, and the Deployment shows `GENERIC_CLIENT_ID`/`GENERIC_CLIENT_SECRET` `secretKeyRef`s pointing at `litellm-sso`.

- [ ] **Step 4: Confirm the IngressRoute has no oauth2 middlewares**

Run:
```bash
grep -i "oauth2\|middleware" apps/litellm/overlays/librepod/ingressroute.yaml || echo "clean (native OIDC — no forward-auth)"
```
Expected: `clean (native OIDC — no forward-auth)`.

- [ ] **Step 5: Commit**

```bash
git add apps/litellm/base/litellm.env apps/litellm/base/deployment.yaml
git commit -m "feat(litellm): enable OIDC SSO env + secretKeyRef to controller Secret"
```

---

### Task 3: Declare the `casdoor-sso` dependency in `metadata.yaml`

**Files:**
- Modify: `apps/litellm/metadata.yaml`

- [ ] **Step 1: Add the `SSOProvider` dependency**

In `apps/litellm/metadata.yaml`, add an entry to `spec.dependencies.required` (after the existing `StorageClass` entry):

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

In the `templates.release` block, insert a `dependsOn:` list as the first field under `spec:` (before `interval: 10m`):

```yaml
      spec:
        dependsOn:
          - name: casdoor-sso
        interval: 10m
        targetNamespace: litellm
```

(Leave the rest of the release template unchanged.)

- [ ] **Step 3: Verify**

Run:
```bash
grep -n "SSOProvider\|dependsOn\|casdoor-sso" apps/litellm/metadata.yaml
```
Expected: one `SSOProvider` line and a `dependsOn`/`casdoor-sso` pair.

- [ ] **Step 4: Commit**

```bash
git add apps/litellm/metadata.yaml
git commit -m "feat(litellm): depend on casdoor-sso for OIDC provisioning"
```

---

### Task 4: Validate locally + deploy to librepod-dev (runbook)

No new commits in this task.

- [ ] **Step 1: Render + kubeconform the full overlay**

Run:
```bash
kustomize build apps/litellm/overlays/librepod \
  | kubeconform \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
      -strict -summary -ignore-missing-schemas
```
Expected: `Summary: ... invalid: 0`. The `SSOClient` shows as skipped (no public schema); all standard resources validate.

- [ ] **Step 2: Confirm the controller is healthy on dev**

Run:
```bash
KC=./librepod-dev.config
kubectl --kubeconfig $KC get ssoclient -A | head
kubectl --kubeconfig $KC -n casdoor-sso-controller get deploy
```
Expected: CRD installed, controller `Ready`.

- [ ] **Step 3: Apply the overlay to dev (substituting BASE_DOMAIN)**

Run:
```bash
KC=./librepod-dev.config
export BASE_DOMAIN=librepod.dev
kustomize build apps/litellm/overlays/librepod \
  | envsubst '${BASE_DOMAIN}' \
  | kubectl --kubeconfig $KC apply -f -
kubectl --kubeconfig $KC -n litellm rollout status deploy/litellm --timeout=180s
```
Expected: resources apply; deployment reaches `Running` (litellm + postgres). On first apply the pod may briefly wait in `CreateContainerConfigError` until the controller reconciles the `SSOClient` and writes `Secret/litellm-sso` — it self-heals within seconds.

- [ ] **Step 4: Verify the SSOClient reconciled and the Secret exists**

Run:
```bash
KC=./librepod-dev.config
kubectl --kubeconfig $KC -n litellm get ssoclient litellm-sso
kubectl --kubeconfig $KC -n litellm get secret litellm-sso -o jsonpath='{.data}' && echo
```
Expected: `Phase=Ready` (`Ready=True`); Secret has three keys (`GENERIC_CLIENT_ID`, `GENERIC_CLIENT_SECRET`, `GENERIC_ISSUER`).

- [ ] **Step 5: Verify OIDC login end-to-end**

Open `https://litellm.<dev-domain>/` and sign in via the Casdoor OIDC flow (the LiteLLM admin UI "SSO" button). Confirm a user is created/matched.

Expected: redirect to Casdoor → consent → back to LiteLLM signed in.

- [ ] **Step 6: Record results; no commit**

Note outcomes in the PR description. File follow-ups as issues. **Do not edit `catalog.yaml`** — CI regenerates it from the `metadata.yaml` change.

---

## Self-review notes (plan author)

- **Spec coverage (§5.2):** `SSOClient` CR + redirect `/sso/callback` → Task 1. Literal `GENERIC_*_ENDPOINT` + `PROXY_BASE_URL` (with `https://`) → Task 2 Step 1. `secretKeyRef` id/secret → Task 2 Step 2. IngressRoute middleware-free → Task 2 Step 4. `dependsOn: casdoor-sso` + `SSOProvider` → Task 3. Validation → Task 4. Pre-existing broken build (gluetun) → Prerequisite.
- **Bare-issuer invariant:** litellm takes specific endpoint URLs as literals (Task 2); the controller's `issuer` output key maps to `GENERIC_ISSUER` (Task 1) but is NOT consumed — consistent with the design's §3 note.
- **No cross-app edits:** all paths under `apps/litellm/`. `catalog.yaml` untouched.
- **Known pre-existing issues (out of SSO scope — file separately, do NOT fix here):**
  - `LITELM_SALT_KEY` typo in `base/litellm.env` (missing `L`) + hardcoded value shadowing the metadata `LITELLM_SALT_KEY` param/secret. Left untouched to avoid changing litellm's startup behavior mid-SSO.
  - `LITELLM_MASTER_KEY=sk-1234` placeholder (the existing `# FIXME`).
  - `base/secret.yaml` defines `litellm-secrets` but the Deployment never references it.
- **Licensing caveat:** LiteLLM SSO is free for ≤5 users (Enterprise above) — acceptable for personal/home clusters; already noted in the spec.
