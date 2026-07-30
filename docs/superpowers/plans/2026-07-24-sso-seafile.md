# seafile SSO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire OAuth2 single-sign-on to Seafile CE through the `casdoor-sso-controller`, with zero committed secrets.

**Architecture:** Add an `SSOClient` CR — the controller provisions the Casdoor OAuth application and writes `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` into `Secret/seafile-sso` at runtime. Seafile CE reads OAuth from `seahub_settings.py` (a config **file**, not env), so a `postStart` lifecycle hook on the seafile container appends a marker-guarded OAuth block to `/shared/seafile/conf/seahub_settings.py` after seafile-mc generates it; the block reads the client id/secret from the container env (which comes from the controller Secret via `secretKeyRef`). Seafile handles its own OAuth login, so the IngressRoute stays middleware-free.

**Tech Stack:** Kustomize (base/overlay + mysql & redis components), FluxCD GitOps, `SSOClient` CRD (`marketplace.librepod.org/v1alpha1`), Casdoor as an OAuth2/OIDC provider. Image is `seafileltd/seafile-mc:13.0-latest` — no bump. Seafile CE supports **OAuth2** (native OIDC/SAML is Pro-only); pointing OAuth2 at Casdoor's OIDC endpoints with the `openid` scope is the officially documented path.

**Spec:** `docs/superpowers/specs/2026-07-24-marketplace-app-sso-rollout-design.md` §5.3
**Upstream manual:** <https://manual.seafile.com/latest/config/oauth/#oauth>
**Author guide:** `docs/sso-app-author-guide.md`
**App skill:** `.claude/skills/librepod-app` (conventions) and `.claude/skills/verify-app` (dev-cluster validation)

## Global Constraints

- **Scope confined to `apps/seafile/` only** — runs in a worktree alongside three sibling plans; touch no other app and no shared file.
- **Never hand-edit `catalog.yaml`** — CI regenerates it from `metadata.yaml`.
- The OAuth endpoint URLs and redirect URL in the injected block carry `${BASE_DOMAIN}` (substituted by Flux at render time, in the Deployment manifest itself). They are NOT taken from the controller's `issuer` key.
- **Trailing slashes matter** on the Seafile OAuth URLs exactly as shown (`/oauth/callback/`).
- `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` are read by the injected block via `os.environ[...]` at seahub import time, so the seafile container MUST carry those env vars (Task 2).
- The injected block uses `os.environ` (not a baked secret literal), so **rotation = restart the pod** (no file rewrite needed).

**Working directory:** `/home/alex/code/librepod/marketplace`. Feature branch (e.g. `feat/seafile-sso`); worktree starts from `master`.

**Dev cluster:** `./librepod-dev.config` (gitignored). Pass `--kubeconfig ./librepod-dev.config` to every kubectl call.

---

### Task 1: Add the `SSOClient` CR to the overlay

**Files:**
- Create: `apps/seafile/overlays/librepod/ssoclient.yaml`
- Modify: `apps/seafile/overlays/librepod/kustomization.yaml` (register the CR in `resources:`)

**Interfaces:**
- Produces: `Secret/seafile-sso` (namespace `seafile`) with keys `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_ISSUER` — consumed by Task 2's `secretKeyRef`.

- [ ] **Step 1: Create the `SSOClient` CR**

Create `apps/seafile/overlays/librepod/ssoclient.yaml`:

```yaml
# The casdoor-sso-controller reconciles this CR: it provisions the Casdoor
# OAuth/OIDC application (clientId "seafile") and writes the client id/secret
# into Secret/seafile-sso in this namespace. Seafile reads
# OAUTH_CLIENT_ID/OAUTH_CLIENT_SECRET from that Secret via env (Task 2);
# OAUTH_ISSUER is the controller's discovery URL and is left unused — Seafile
# takes its endpoints from the literal URLs injected into seahub_settings.py.
apiVersion: marketplace.librepod.org/v1alpha1
kind: SSOClient
metadata:
  name: seafile-sso
  namespace: seafile
spec:
  clientId: seafile
  organization: librepod
  redirectUris:
    - "https://seafile.${BASE_DOMAIN}/oauth/callback/"
  grantTypes: [authorization_code, refresh_token]
  tokenFormat: JWT
  expireInHours: 168
  output:
    secretName: seafile-sso
    keys:
      clientId: OAUTH_CLIENT_ID
      clientSecret: OAUTH_CLIENT_SECRET
      issuer: OAUTH_ISSUER
  casdoorPolicy: retain
```

- [ ] **Step 2: Register it in the overlay kustomization**

In `apps/seafile/overlays/librepod/kustomization.yaml`, add `- ssoclient.yaml` to the `resources:` list (after `- ingressroute.yaml`):

```yaml
resources:
- ../../base
- ../../components/mysql
- ../../components/redis
- ingressroute.yaml
- ssoclient.yaml
```

- [ ] **Step 3: Build to verify the CR renders**

Run:
```bash
kustomize build apps/seafile/overlays/librepod | grep -A3 "kind: SSOClient"
```
Expected: `SSOClient` renders with `name: seafile-sso`, `namespace: seafile`, `clientId: seafile`, redirect URI `https://seafile.${BASE_DOMAIN}/oauth/callback/`.

- [ ] **Step 4: Commit**

```bash
git add apps/seafile/overlays/librepod/ssoclient.yaml apps/seafile/overlays/librepod/kustomization.yaml
git commit -m "feat(seafile): add SSOClient CR for OAuth2 SSO"
```

---

### Task 2: Inject OAuth into `seahub_settings.py` (Shape-B packaging)

Add the controller-Secret env vars to the seafile container, and a `postStart` hook that appends the OAuth block to the generated `seahub_settings.py`.

**Files:**
- Modify: `apps/seafile/base/deployment.yaml`

**Interfaces:**
- Consumes: `Secret/seafile-sso` keys `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` produced by Task 1.

**Why `postStart` (not an init container):** seafile-mc generates `/shared/seafile/conf/seahub_settings.py` inside the **main** container's entrypoint, which runs *after* all init containers. An init container therefore cannot reliably append to a file that does not yet exist. A `postStart` hook runs after the container starts (after the file is generated) and is marker-guarded so it is idempotent. Because seahub loads `seahub_settings.py` only at process start, the **first** deploy needs one pod restart so seahub reloads the file with the block present (see Task 4); subsequent restarts work from the first try (the file persists with the block, and seafile-mc preserves an existing file).

- [ ] **Step 1: Add the controller-Secret env vars**

In `apps/seafile/base/deployment.yaml`, add two entries to the `seafile` container's `env:` list (after the existing `INIT_SEAFILE_ADMIN_PASSWORD` entry):

```yaml
          env:
            - name: SEAF_SERVER_STORAGE_TYPE
              value: "disk"
            - name: SEAFILE_AI_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: seafile-secret
                  key: JWT_PRIVATE_KEY
            - name: INIT_SEAFILE_ADMIN_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: seafile-secret
                  key: INIT_SEAFILE_ADMIN_PASSWORD
            - name: OAUTH_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: seafile-sso
                  key: OAUTH_CLIENT_ID
            - name: OAUTH_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: seafile-sso
                  key: OAUTH_CLIENT_SECRET
```

- [ ] **Step 2: Add the `postStart` OAuth-injection hook**

In the same `seafile` container, add a `lifecycle:` block (sibling of `envFrom:` / `ports:` / `volumeMounts:`). The full container spec becomes:

```yaml
        - name: seafile
          image: seafileltd/seafile-mc
          imagePullPolicy: IfNotPresent
          env:
            - name: SEAF_SERVER_STORAGE_TYPE
              value: "disk"
            - name: SEAFILE_AI_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: seafile-secret
                  key: JWT_PRIVATE_KEY
            - name: INIT_SEAFILE_ADMIN_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: seafile-secret
                  key: INIT_SEAFILE_ADMIN_PASSWORD
            - name: OAUTH_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: seafile-sso
                  key: OAUTH_CLIENT_ID
            - name: OAUTH_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: seafile-sso
                  key: OAUTH_CLIENT_SECRET
          envFrom:
            - configMapRef:
                name: seafile
            - secretRef:
                name: seafile-secret
          lifecycle:
            postStart:
              exec:
                command:
                  - sh
                  - -c
                  - |
                    f=/shared/seafile/conf/seahub_settings.py
                    m="# >>> librepod-sso (managed) >>>"
                    # Wait for seafile-mc to generate the file (first boot).
                    i=0
                    while [ ! -f "$f" ] && [ "$i" -lt 60 ]; do sleep 2; i=$((i+1)); done
                    [ -f "$f" ] || exit 0
                    # Append once (marker-guarded). os.environ is read by seahub
                    # at import time, so rotation just needs a pod restart.
                    grep -q "$m" "$f" && exit 0
                    cat >> "$f" <<'PY'

                    # >>> librepod-sso (managed) >>>
                    import os
                    ENABLE_OAUTH = True
                    OAUTH_ENABLE_INSECURE_TRANSPORT = False
                    OAUTH_CLIENT_ID = os.environ["OAUTH_CLIENT_ID"]
                    OAUTH_CLIENT_SECRET = os.environ["OAUTH_CLIENT_SECRET"]
                    OAUTH_REDIRECT_URL = "https://seafile.${BASE_DOMAIN}/oauth/callback/"
                    OAUTH_PROVIDER = "casdoor"
                    OAUTH_AUTHORIZATION_URL = "https://sso.${BASE_DOMAIN}/login/oauth/authorize"
                    OAUTH_TOKEN_URL = "https://sso.${BASE_DOMAIN}/login/oauth/access_token"
                    OAUTH_USER_INFO_URL = "https://sso.${BASE_DOMAIN}/api/userinfo"
                    OAUTH_SCOPE = ["openid", "profile", "email"]
                    OAUTH_ATTRIBUTE_MAP = {
                        "sub":   (True,  "uid"),
                        "name":  (False, "name"),
                        "email": (False, "contact_email"),
                    }
                    CSRF_TRUSTED_ORIGINS = ["https://seafile.${BASE_DOMAIN}"]
                    # <<< librepod-sso (managed) <<<
                    PY
          ports:
            - containerPort: 80
          volumeMounts:
            - name: seafile-data
              mountPath: /shared
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
```

(The single-quoted heredoc `<<'PY'` keeps the shell from expanding the Python; `${BASE_DOMAIN}` is substituted by Flux at manifest-render time, before the shell runs. `os.environ[...]` is read by seahub at settings-import time.)

- [ ] **Step 3: Build and confirm Flux did not mangle the shell vars**

Run:
```bash
kustomize build apps/seafile/overlays/librepod > /tmp/sf-rendered.yaml
grep -n 'OAUTH_CLIENT_ID\|OAUTH_REDIRECT_URL\|librepod-sso (managed)' /tmp/sf-rendered.yaml
grep -n 'f=/shared\|grep -q "\$m"' /tmp/sf-rendered.yaml
```
Expected: the heredoc block is present in the rendered Deployment; the bare shell vars (`$f`, `$m`) survive intact (Flux substitutes only `${...}` patterns — confirm `$f`/`$m` are not blanked). The literal `OAUTH_REDIRECT_URL = "https://seafile.librepod.dev/oauth/callback/"`-style line shows `${BASE_DOMAIN}` already resolved when built via the Flux path (with `envsubst` in Task 4 it resolves to `librepod.dev`).

- [ ] **Step 4: Confirm the IngressRoute has no oauth2 middlewares**

Run:
```bash
grep -i "oauth2\|middleware" apps/seafile/overlays/librepod/ingressroute.yaml || echo "clean (native OAuth — no forward-auth)"
```
Expected: `clean (native OAuth — no forward-auth)`.

- [ ] **Step 5: Commit**

```bash
git add apps/seafile/base/deployment.yaml
git commit -m "feat(seafile): inject OAuth block into seahub_settings.py via postStart; read client creds from controller Secret"
```

---

### Task 3: Declare the `casdoor-sso` dependency in `metadata.yaml`

**Files:**
- Modify: `apps/seafile/metadata.yaml`

- [ ] **Step 1: Add the `SSOProvider` dependency**

In `apps/seafile/metadata.yaml`, add an entry to `spec.dependencies.required` (after the existing `StorageClass` entry):

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
        targetNamespace: seafile
```

- [ ] **Step 3: Verify**

Run:
```bash
grep -n "SSOProvider\|dependsOn\|casdoor-sso" apps/seafile/metadata.yaml
```
Expected: one `SSOProvider` line and a `dependsOn`/`casdoor-sso` pair.

- [ ] **Step 4: Commit**

```bash
git add apps/seafile/metadata.yaml
git commit -m "feat(seafile): depend on casdoor-sso for OAuth provisioning"
```

---

### Task 4: Validate locally + deploy to librepod-dev (runbook)

No new commits in this task.

- [ ] **Step 1: Render + kubeconform the full overlay**

Run:
```bash
kustomize build apps/seafile/overlays/librepod \
  | kubeconform \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
      -strict -summary -ignore-missing-schemas
```
Expected: `Summary: ... invalid: 0`. (`SSOClient` skipped — no public schema.)

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
kustomize build apps/seafile/overlays/librepod \
  | envsubst '${BASE_DOMAIN}' \
  | kubectl --kubeconfig $KC apply -f -
kubectl --kubeconfig $KC -n seafile rollout status deploy/seafile --timeout=300s
```
Expected: resources apply; seafile reaches `Running` (seafile-mc takes a while to initialize on first boot — be generous with the timeout).

- [ ] **Step 4: Verify the SSOClient reconciled and the Secret exists**

Run:
```bash
KC=./librepod-dev.config
kubectl --kubeconfig $KC -n seafile get ssoclient seafile-sso
kubectl --kubeconfig $KC -n seafile get secret seafile-sso -o jsonpath='{.data}' && echo
```
Expected: `Phase=Ready`; Secret has three keys.

- [ ] **Step 5: Restart seafile once so it reloads settings with the OAuth block**

Because `postStart` appends the block after seahub has already loaded settings on first boot, restart the pod so seahub re-imports `seahub_settings.py`:

Run:
```bash
KC=./librepod-dev.config
kubectl --kubeconfig $KC -n seafile exec deploy/seafile -- grep "librepod-sso (managed)" /shared/seafile/conf/seahub_settings.py   # confirm the block landed
kubectl --kubeconfig $KC -n seafile rollout restart deploy/seafile
kubectl --kubeconfig $KC -n seafile rollout status deploy/seafile --timeout=300s
```
Expected: the grep prints the marker line (block was injected); the rollout restart completes.

- [ ] **Step 6: Verify OAuth login end-to-end**

Open `https://seafile.<dev-domain>/` and sign in via the Casdoor OAuth flow (Seafile's "Single Sign On" button). Confirm a user is created/matched (mapped via `OAUTH_ATTRIBUTE_MAP`, `sub` → `uid`).

Expected: redirect to Casdoor → consent → back to Seafile signed in.

- [ ] **Step 7: Record results; no commit**

Note outcomes in the PR description. **Do not edit `catalog.yaml`** — CI regenerates it from the `metadata.yaml` change.

---

## Self-review notes (plan author)

- **Spec coverage (§5.3):** `SSOClient` CR + redirect `/oauth/callback/` (trailing slash) → Task 1. Controller-Secret env + `seahub_settings.py` injection + `OAUTH_ATTRIBUTE_MAP` (sub→uid) + `CSRF_TRUSTED_ORIGINS` → Task 2. IngressRoute middleware-free → Task 2 Step 4. `dependsOn: casdoor-sso` + `SSOProvider` → Task 3. Validation + first-boot restart → Task 4.
- **Injection-mechanism choice:** `postStart` (not init container) because seafile-mc generates the settings file in the main entrypoint after init containers run; marker-guarded → idempotent; reads `os.environ` → rotation is just a restart. One first-boot restart is the documented trade-off (Task 4 Step 5).
- **Flux-substitute safety:** only `${BASE_DOMAIN}` is substituted (in the OAUTH URLs); bare shell vars `$f`/`$m`/`$i` and `$(...)` are not `${...}` and are left intact — verified in Task 2 Step 3.
- **No cross-app edits:** all paths under `apps/seafile/`. `catalog.yaml` untouched.
- **Open item to confirm during implementation:** seafile-mc's first-boot `seahub_settings.py` generation/preserve behavior — if it overwrites the file on every start (not just first boot), the marker-guarded `postStart` still re-appends each start, so the design is robust either way; just confirm the block is present and OAuth works after Task 4 Step 5.
- **Known pre-existing (out of SSO scope):** the overlay's `seafile-secret` generator hardcodes `changeme_*` placeholders (DB/redis/admin passwords) — pre-existing, not touched here. `ENABLE_WEBDAV_SECRET` is not set (SSO users have no local password → WebDAV basic-auth unavailable); add later if desktop WebDAV sync is needed.
