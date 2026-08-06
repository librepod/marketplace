# Self-hosted Renovate Marketplace App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic `renovate` marketplace app that runs a self-hosted Renovate bot as a scheduled CronJob, configured entirely by the operator (no repo/platform/policy baked in).

**Architecture:** A `batch/v1` CronJob runs the official `renovate/renovate` image on schedule. The operator's Renovate config lives in an editable `config.json` ConfigMap; the platform token lives in a Secret; a persistent PVC caches datasource/changelog lookups across runs. No inbound networking. Manifests follow the marketplace `base/` + `overlays/librepod/` + `metadata.yaml` convention.

**Tech Stack:** Kubernetes manifests (YAML), Kustomize, FluxCD (postBuild substitution at install time), the `renovate/renovate` container image.

**Reference spec:** `docs/superpowers/specs/2026-08-06-renovate-self-host-app-design.md`

## Global Constraints

(Every task's requirements implicitly include these. Values copied verbatim from the spec.)

- **Image:** `renovate/renovate:44.14.1` (pinned). Verified to run as **UID 12021, gid 0**.
- **Pod security:** `runAsNonRoot: true`, `runAsUser: 12021`, `fsGroup: 12021`, `seccompProfile: { type: RuntimeDefault }`.
- **Version lockstep:** `metadata.yaml spec.version == OCIRepository ref.tag == container image tag == "44.14.1"`. Include the `# renovate: datasource=docker depName=renovate/renovate` comment above both the `version:` field and the container `image:` so the bot can self-update.
- **Secret file rule:** `base/secret.yaml` MUST be a plain `Secret` with `${VAR}` in `stringData` — NOT a `secretGenerator`. (A secretGenerator base64-encodes before Flux substitution and leaves `${VAR}` literal.)
- **No inbound networking:** do NOT create a `Service`, `IngressRoute`, or any `BASE_DOMAIN` param. Renovate is outbound-only.
- **Safe default:** the shipped `config.json` has `"autodiscover": false` and `"repositories": []` — a freshly installed bot must do nothing until the operator configures it.
- **Namespace:** `renovate`. Set `namespace: renovate` explicitly on every namespaced resource.
- **Category:** `Development`.
- **CI gate (must pass):** `kustomize build apps/renovate/overlays/librepod` succeeds, and the rendered output passes `kubeconform -strict` (built-in kinds CronJob/Secret/ConfigMap/PVC/Namespace are fully schema-validated — field names must be exact). Literal `${VAR}` strings are valid (they're just string values); Flux substitutes them at reconcile time.
- **Do NOT touch:** `.github/workflows/renovate.yaml` (out of scope) and `catalog.yaml` (the `publish-catalog.yaml` CI regenerates it automatically from `metadata.yaml`; hand-editing is wasted and will be overwritten).
- **Env for validation commands:** prefer `nix-shell shell.nix --run '<cmd>'` (matches CI and guarantees `kustomize`/`kubeconform`/`flux` versions). If those tools are already on `PATH`, run the inner command directly.

## File Structure

```
apps/renovate/
├── metadata.yaml                 # AppDefinition: params (SCHEDULE, LOG_LEVEL), secrets (RENOVATE_TOKEN req, RENOVATE_GITHUB_COM_TOKEN opt), templates
├── base/
│   ├── kustomization.yaml        # resources: namespace, configmap, secret, pvc, cronjob
│   ├── namespace.yaml            # Namespace: renovate
│   ├── configmap.yaml            # default config.json (operator edits)
│   ├── secret.yaml               # plain Secret, ${VAR} stringData (NOT secretGenerator)
│   ├── pvc.yaml                  # cache PVC, nfs-client, 5Gi, RWX
│   └── cronjob.yaml              # the runner
└── overlays/librepod/
    └── kustomization.yaml        # resources: ../../base
```

Each file has one responsibility (one resource per file, except `kustomization.yaml`). Files that change together (all base resources are part of "the renovate workload") live together under `base/`.

---

### Task 1: Scaffold app skeleton, `metadata.yaml`, and Namespace

**Files:**
- Create: `apps/renovate/base/namespace.yaml`
- Create: `apps/renovate/base/kustomization.yaml`
- Create: `apps/renovate/overlays/librepod/kustomization.yaml`
- Create: `apps/renovate/metadata.yaml`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces: a recognizable marketplace app (`metadata.yaml` present, overlay buildable) and the `renovate` Namespace. Later tasks add resources referenced by `base/kustomization.yaml`.

- [ ] **Step 1: Create `apps/renovate/base/namespace.yaml`**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: renovate
```

- [ ] **Step 2: Create `apps/renovate/base/kustomization.yaml`** (only namespace for now; later tasks append resources)

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
```

- [ ] **Step 3: Create `apps/renovate/overlays/librepod/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
```

- [ ] **Step 4: Create `apps/renovate/metadata.yaml`** (full AppDefinition — modeled on `apps/wg-easy/metadata.yaml` + `apps/litellm/metadata.yaml`)

```yaml
apiVersion: marketplace/v1
kind: AppDefinition
metadata:
  name: renovate
spec:
  displayName: "Renovate"
  description: "Self-hosted Renovate dependency-update bot. Runs on a schedule and opens pull requests on your Git repositories (GitHub, GitLab, Gitea, Bitbucket, GitHub Enterprise). Bring your own configuration: point it at your platform and repositories by editing the config.json ConfigMap, and supply a personal access token. No inbound networking is required — the bot only reaches out to your Git platform."
  icon: "https://docs.renovatebot.com/assets/images/logo.png"
  category: "Development"
  website: "https://docs.renovatebot.com/"

  # renovate: datasource=docker depName=renovate/renovate
  version: "44.14.1"

  source:
    type: oci-kustomize
    url: "oci://ghcr.io/librepod/marketplace/apps/renovate"
    path: ./overlays/librepod

  params:
    optional:
      - name: SCHEDULE
        description: "Cron schedule for Renovate runs (standard 5-field cron, or a preset like @hourly / @daily)."
        type: string
        default: "@hourly"
        example: "0 */2 * * *"
      - name: LOG_LEVEL
        description: "Renovate log level (one of: trace, debug, info, warn, error, fatal)."
        type: string
        default: "info"
        example: "debug"

  secrets:
    - name: RENOVATE_TOKEN
      description: "Personal Access Token (or GitHub App installation token) for the target Git platform. Needs repo, pull-request, and issues scopes (issues = dependency dashboard)."
      required: true
    - name: RENOVATE_GITHUB_COM_TOKEN
      description: "Optional PAT for github.com, used to fetch changelogs when the target platform is NOT github.com (e.g. GitLab/Gitea/GHE). Leave empty if targeting github.com — the main token is reused for changelogs."
      required: false

  dependencies:
    required:
      - kind: StorageClass
        description: "nfs-client (provided by bootstrap) — for the persistent cache PVC"

  templates:
    source: |
      apiVersion: source.toolkit.fluxcd.io/v1
      kind: OCIRepository
      metadata:
        name: marketplace-renovate
        namespace: flux-system
        labels:
          marketplace.io/managed: "true"
          marketplace.io/app: "renovate"
      spec:
        interval: 10m
        url: oci://ghcr.io/librepod/marketplace/apps/renovate
        ref:
          tag: "__VERSION__"
    release: |
      apiVersion: kustomize.toolkit.fluxcd.io/v1
      kind: Kustomization
      metadata:
        name: marketplace-renovate
        namespace: flux-system
        labels:
          marketplace.io/managed: "true"
          marketplace.io/app: "renovate"
      spec:
        dependsOn:
          - name: storage
        interval: 10m
        retryInterval: 2m
        timeout: 5m
        targetNamespace: renovate
        sourceRef:
          kind: OCIRepository
          name: marketplace-renovate
        path: ./overlays/librepod
        prune: true
        wait: true
        postBuild:
          substitute:
            SCHEDULE: "${SCHEDULE}"
            LOG_LEVEL: "${LOG_LEVEL}"
          substituteFrom:
            - kind: Secret
              name: renovate-config
    secret: |
      apiVersion: v1
      kind: Secret
      metadata:
        name: renovate-config
        namespace: flux-system
        labels:
          marketplace.io/managed: "true"
          marketplace.io/app: "renovate"
      type: Opaque
      stringData:
        RENOVATE_TOKEN: "${RENOVATE_TOKEN}"
        RENOVATE_GITHUB_COM_TOKEN: "${RENOVATE_GITHUB_COM_TOKEN}"
    kustomization: |
      apiVersion: kustomize.config.k8s.io/v1beta1
      kind: Kustomization
      resources:
        - source.yaml
        - release.yaml
```

- [ ] **Step 5: Verify the overlay builds and renders the Namespace**

Run (nix-shell form, matches CI):
```bash
nix-shell shell.nix --run 'kustomize build apps/renovate/overlays/librepod'
```
Expected: a YAML document for `kind: Namespace` with `metadata.name: renovate`. No errors.

- [ ] **Step 6: Verify it passes kubeconform**

```bash
nix-shell shell.nix --run '
  kustomize build apps/renovate/overlays/librepod > /tmp/renovate-rendered.yaml
  kubeconform \
    -schema-location default \
    -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
    -strict -ignore-missing-schemas -summary /tmp/renovate-rendered.yaml
'
```
Expected: `Summary: 1 resource found in 1 file - Valid: 1, Invalid: 0, Errors: 0` (Namespace is a built-in kind, fully validated).

- [ ] **Step 7: Commit**

```bash
git add apps/renovate/metadata.yaml apps/renovate/base/namespace.yaml apps/renovate/base/kustomization.yaml apps/renovate/overlays/librepod/kustomization.yaml
git commit -m "feat(renovate): scaffold app, metadata, and namespace"
```

---

### Task 2: Default `config.json` ConfigMap

**Files:**
- Create: `apps/renovate/base/configmap.yaml`
- Modify: `apps/renovate/base/kustomization.yaml`

**Interfaces:**
- Consumes: Namespace from Task 1.
- Produces: ConfigMap `renovate-config` in namespace `renovate`, with key `config.json`. The CronJob (Task 4) mounts this at `/opt/renovate/config.json`.

- [ ] **Step 1: Create `apps/renovate/base/configmap.yaml`**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: renovate-config
  namespace: renovate
data:
  config.json: |
    {
      "platform": "github",
      "endpoint": "",
      "autodiscover": false,
      "repositories": [],
      "gitAuthor": "Renovate Bot <bot@renovateapp.com>",
      "onboardingConfigFileName": "renovate.json",
      "extends": ["config:recommended"]
    }
```

Notes baked into the file's purpose (do not add as YAML comments inside `data`): `autodiscover: false` + empty `repositories` is intentional — a fresh install does nothing until the operator edits this. Per-repo schedules/rules stay in each target repo's own `renovate.json`, so they are absent here.

- [ ] **Step 2: Add the ConfigMap to `apps/renovate/base/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - configmap.yaml
```

- [ ] **Step 3: Verify build + kubeconform**

```bash
nix-shell shell.nix --run '
  kustomize build apps/renovate/overlays/librepod > /tmp/renovate-rendered.yaml
  kubeconform \
    -schema-location default \
    -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
    -strict -ignore-missing-schemas -summary /tmp/renovate-rendered.yaml
'
```
Expected: `Summary: 2 resources ... Valid: 2, Invalid: 0, Errors: 0`.

- [ ] **Step 4: Commit**

```bash
git add apps/renovate/base/configmap.yaml apps/renovate/base/kustomization.yaml
git commit -m "feat(renovate): add default config.json ConfigMap"
```

---

### Task 3: Token Secret + cache PVC

**Files:**
- Create: `apps/renovate/base/secret.yaml`
- Create: `apps/renovate/base/pvc.yaml`
- Modify: `apps/renovate/base/kustomization.yaml`

**Interfaces:**
- Consumes: Namespace from Task 1; Flux `substituteFrom: Secret/renovate-config` (defined in `metadata.yaml` Task 1) provides the real values for `${RENOVATE_TOKEN}` / `${RENOVATE_GITHUB_COM_TOKEN}` at reconcile time.
- Produces: Secret `renovate-env` (consumed by CronJob `envFrom` in Task 4) and PVC `renovate-cache` (consumed by CronJob `volumeMount` in Task 4).

- [ ] **Step 1: Create `apps/renovate/base/secret.yaml`** (plain Secret — NOT a secretGenerator)

```yaml
# Plain Secret with ${VAR} stringData.
#
# This MUST be a plain Secret, NOT a kustomize secretGenerator: a
# secretGenerator base64-encodes its output BEFORE Flux's text
# substitution runs, so ${VAR} would survive unchanged and Renovate would
# receive the literal string. Plain stringData stays human-readable in the
# rendered manifest, so Flux CAN substitute it. Same pattern as
# apps/frpc/base/secret.yaml and apps/seafile/base/secret.yaml.
#
# Values are injected by the Flux Kustomization's postBuild.substituteFrom
# (Secret/renovate-config), which the marketplace installer creates from
# the operator-supplied secrets declared in metadata.yaml.
apiVersion: v1
kind: Secret
metadata:
  name: renovate-env
  namespace: renovate
type: Opaque
stringData:
  RENOVATE_TOKEN: "${RENOVATE_TOKEN}"
  RENOVATE_GITHUB_COM_TOKEN: "${RENOVATE_GITHUB_COM_TOKEN}"
```

- [ ] **Step 2: Create `apps/renovate/base/pvc.yaml`**

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: renovate-cache
  namespace: renovate
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-client
  resources:
    requests:
      storage: 5Gi
```

- [ ] **Step 3: Add both to `apps/renovate/base/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - configmap.yaml
  - secret.yaml
  - pvc.yaml
```

- [ ] **Step 4: Verify build + kubeconform**

```bash
nix-shell shell.nix --run '
  kustomize build apps/renovate/overlays/librepod > /tmp/renovate-rendered.yaml
  kubeconform \
    -schema-location default \
    -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
    -strict -ignore-missing-schemas -summary /tmp/renovate-rendered.yaml
'
```
Expected: `Summary: 4 resources ... Valid: 4, Invalid: 0, Errors: 0`. The literal `${RENOVATE_TOKEN}` values are valid (Secret `stringData` is a map of strings).

- [ ] **Step 5: Commit**

```bash
git add apps/renovate/base/secret.yaml apps/renovate/base/pvc.yaml apps/renovate/base/kustomization.yaml
git commit -m "feat(renovate): add token Secret and cache PVC"
```

---

### Task 4: The CronJob runner

**Files:**
- Create: `apps/renovate/base/cronjob.yaml`
- Modify: `apps/renovate/base/kustomization.yaml`

**Interfaces:**
- Consumes: ConfigMap `renovate-config` (Task 2, mounted at `/opt/renovate/config.json`), Secret `renovate-env` (Task 3, via `envFrom`), PVC `renovate-cache` (Task 3, mounted at `/tmp/renovate/cache`), and the Flux-substituted `${SCHEDULE}` / `${LOG_LEVEL}` (from `metadata.yaml` params).
- Produces: the complete, runnable app. After this task the overlay renders all 5 resources and passes the CI gate.

- [ ] **Step 1: Create `apps/renovate/base/cronjob.yaml`**

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: renovate
  namespace: renovate
spec:
  schedule: "${SCHEDULE}"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          securityContext:
            runAsNonRoot: true
            runAsUser: 12021
            fsGroup: 12021
            seccompProfile:
              type: RuntimeDefault
          containers:
            - name: renovate
              # renovate: datasource=docker depName=renovate/renovate
              image: renovate/renovate:44.14.1
              env:
                - name: LOG_LEVEL
                  value: "${LOG_LEVEL}"
                - name: RENOVATE_CONFIG_FILE
                  value: /opt/renovate/config.json
                - name: RENOVATE_BASE_DIR
                  value: /tmp/renovate
              envFrom:
                - secretRef:
                    name: renovate-env
              volumeMounts:
                - name: config
                  mountPath: /opt/renovate
                  readOnly: true
                - name: work
                  mountPath: /tmp/renovate
                - name: cache
                  mountPath: /tmp/renovate/cache
              resources:
                requests:
                  cpu: 100m
                  memory: 256Mi
                limits:
                  memory: 1Gi
          volumes:
            - name: config
              configMap:
                name: renovate-config
            - name: work
              emptyDir: {}
            - name: cache
              persistentVolumeClaim:
                claimName: renovate-cache
```

- [ ] **Step 2: Add the CronJob to `apps/renovate/base/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - configmap.yaml
  - secret.yaml
  - pvc.yaml
  - cronjob.yaml
```

- [ ] **Step 3: Verify build renders all 5 resources**

```bash
nix-shell shell.nix --run 'kustomize build apps/renovate/overlays/librepod'
```
Expected: 5 documents — Namespace, ConfigMap, Secret, PersistentVolumeClaim, CronJob — in namespace `renovate`. The CronJob `schedule:` shows `${SCHEDULE}` (substituted by Flux later) and the container `image:` shows `renovate/renovate:44.14.1`.

- [ ] **Step 4: Verify kubeconform passes (strict — CronJob is fully schema-validated)**

```bash
nix-shell shell.nix --run '
  kustomize build apps/renovate/overlays/librepod > /tmp/renovate-rendered.yaml
  kubeconform \
    -schema-location default \
    -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
    -strict -ignore-missing-schemas -summary /tmp/renovate-rendered.yaml
'
```
Expected: `Summary: 5 resources ... Valid: 5, Invalid: 0, Errors: 0`. If `Invalid`, the most likely cause is a misspelled CronJob/Pod field — compare field names against `kubectl explain cronjob.spec.jobTemplate.spec.template.spec` and fix.

- [ ] **Step 5: Commit**

```bash
git add apps/renovate/base/cronjob.yaml apps/renovate/base/kustomization.yaml
git commit -m "feat(renovate): add scheduled runner CronJob"
```

---

### Task 5: CI-mirror validation + substitution sanity

**Goal:** Run the exact validation the `validate-apps.yaml` CI runs, plus a sanity check that the Flux-substituted variables resolve into well-formed values. This is the gate before opening a PR.

**Files:**
- No new files. Reads only.

**Interfaces:**
- Consumes: the complete app from Tasks 1–4.

- [ ] **Step 1: Run the exact CI sequence (kustomize build + kubeconform + flux build)**

```bash
nix-shell shell.nix --run '
  set -euo pipefail
  echo "== kustomize build =="
  kustomize build apps/renovate/overlays/librepod > /tmp/renovate-rendered.yaml
  echo "== kubeconform =="
  kubeconform \
    -schema-location default \
    -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
    -strict -ignore-missing-schemas -summary /tmp/renovate-rendered.yaml
  echo "== flux build (non-blocking render check) =="
  flux build kustomization renovate \
    --path apps/renovate/overlays/librepod \
    --local-sources GitRepository/flux-system/librepod-apps=./ \
    --dry-run || true
'
```
Expected: kustomize builds 5 resources; kubeconform reports `Valid: 5, Invalid: 0, Errors: 0`; flux build renders without error (the `|| true` mirrors CI, since flux build here only does kustomize rendering — Flux postBuild substitution happens at reconcile time via the installer-generated Kustomization, not in-repo).

- [ ] **Step 2: Sanity-check that variable substitution yields valid values**

Confirm what the cluster will actually see once Flux substitutes. Substitute realistic values into the rendered YAML and re-run kubeconform:

```bash
nix-shell shell.nix --run '
  SCHEDULE="@hourly" LOG_LEVEL="info" \
  RENOVATE_TOKEN="fake-token" RENOVATE_GITHUB_COM_TOKEN="" \
  kustomize build apps/renovate/overlays/librepod \
  | sed \
      -e "s/\${SCHEDULE}/@hourly/g" \
      -e "s/\${LOG_LEVEL}/info/g" \
      -e "s/\${RENOVATE_TOKEN}/fake-token/g" \
      -e "s/\${RENOVATE_GITHUB_COM_TOKEN}//g" \
  > /tmp/renovate-substituted.yaml
  kubeconform \
    -schema-location default \
    -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
    -strict -ignore-missing-schemas -summary /tmp/renovate-substituted.yaml
  grep -E "schedule:|value: info|image:" /tmp/renovate-substituted.yaml
'
```
Expected: kubeconform `Valid: 5, Invalid: 0, Errors: 0`; grep shows `schedule: '@hourly'` (a valid cron preset), `value: info`, and the pinned image. (Note: `envsubst` is intentionally NOT used — on this box it is non-GNU and mangles the format string; `sed` is reliable here.)

- [ ] **Step 3: Confirm `catalog.yaml` does NOT need editing**

```bash
git status --short catalog.yaml
```
Expected: no output (catalog.yaml is untouched — the `publish-catalog.yaml` CI regenerates it from `metadata.yaml` on merge). Do not commit any catalog.yaml change.

- [ ] **Step 4: No commit needed** (this task only validates). If Steps 1–2 pass and Step 3 shows no catalog change, the app is ready for PR.

---

### Task 6 (OPTIONAL): Dev-cluster smoke test

**Only if you have dev-cluster access (`./librepod-dev.config`) and want end-to-end verification before/after PR.** The required gate is Task 5; this is extra confidence, especially for the NFS+`fsGroup` writability risk flagged in the spec (§6.5).

**Files:**
- No file changes (cluster-side verification). Temporarily edits the `config.json` to a dry-run target, then reverts.

**Interfaces:**
- Consumes: the app from Tasks 1–4 and a live cluster with the `nfs-client` StorageClass.

- [ ] **Step 1: Apply directly to the dev cluster with substitute values**

The app's Flux Kustomization is installer-generated, so to test the raw manifests directly, render with real values and apply (see `docs/FLUX_WORKFLOW.md` and the `dev-cluster-app-testing-flow` memory — direct apply is the path for non-GitRepository apps):

```bash
nix-shell shell.nix --run '
  kustomize build apps/renovate/overlays/librepod \
  | sed -e "s/\${SCHEDULE}/@hourly/g" \
        -e "s/\${LOG_LEVEL}/debug/g" \
        -e "s/\${RENOVATE_TOKEN}/REPLACE_WITH_REAL_PAT/g" \
        -e "s/\${RENOVATE_GITHUB_COM_TOKEN}//g" \
  | kubectl --kubeconfig ./librepod-dev.config apply -f -
'
```
Replace `REPLACE_WITH_REAL_PAT` with a real throwaway PAT for a platform you control.

- [ ] **Step 2: Trigger a run immediately (don't wait for the schedule)**

```bash
kubectl --kubeconfig ./librepod-dev.config -n renovate create job --from=cronjob/renovate renovate-manual-$$
kubectl --kubeconfig ./librepod-dev.config -n renovate logs job/renovate-manual-$$ -f
```
Expected: Renovate starts in debug mode, logs `LOG_LEVEL` lines, and (because the default config has empty repositories) completes without error.

- [ ] **Step 3: Verify the cache PVC is writable (the key risk)**

```bash
kubectl --kubeconfig ./librepod-dev.config -n renovate describe pod -l job-name=renovate-manual-$$ | grep -A3 "Conditions\|Containers"
kubectl --kubeconfig ./librepod-dev.config -n renovate logs job/renovate-manual-$$ | grep -iE "EACCES|permission denied|cache"
```
Expected: the pod's container runs (not `CrashLoopBackOff`), and logs show NO `EACCES` / "permission denied" writing to `/tmp/renovate/cache`. If you DO see `EACCES`: the NFS server is squashing to a uid other than 12021. Per spec §6.5 fallback, either (a) match the NFS `anonuid` to 12021 on the server, or (b) change the `cache` volume from the PVC to an `emptyDir: {}` (trading persistence) and re-validate.

- [ ] **Step 4: Clean up**

```bash
kubectl --kubeconfig ./librepod-dev.config -n renovate delete job -l job-name=renovate-manual-$$ --ignore-not-found
kubectl --kubeconfig ./librepod-dev.config delete namespace renovate --ignore-not-found
```

- [ ] **Step 5: No commit** (smoke test only; the manifests are unchanged from Task 4).

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- §5 file layout → Tasks 1–4 create every listed file. ✓
- §6.1 Namespace → Task 1. ✓
- §6.2 ConfigMap (default config.json, safe no-op default) → Task 2. ✓
- §6.3 plain-Secret-not-secretGenerator rule → Task 3 Step 1 (comment + structure). ✓
- §6.4 PVC (nfs-client, 5Gi, RWX) → Task 3 Step 2. ✓
- §6.5 CronJob (image pin, UID 12021, fsGroup 12021, concurrencyPolicy Forbid, history limits, env/envFrom, 3 volumes, resources, self-update comment) → Task 4. ✓
- §6.6 base kustomization → Tasks 1–4 build it incrementally. ✓
- §6.7 overlay kustomization → Task 1. ✓
- §7 metadata.yaml (params optional w/ defaults, secrets req+opt, dependencies StorageClass, templates source/release/secret/kustomization, dependsOn storage) → Task 1 Step 4. ✓
- §8 security (runAsNonRoot, seccomp, token only in Secret, autodiscover false default) → Tasks 1, 3, 4. ✓
- §9 validation (kustomize build + kubeconform + flux build --dry-run + substitution check + optional dev smoke incl. EACCES check) → Tasks 5, 6. ✓
- §10 verify items (logo resolved, UID resolved to 12021, optional params+default proven by wg-easy, optional secret `required:false` confirmed via AppSecretDef type, dependsOn `storage` matches headscale, catalog not hand-edited) → folded into Global Constraints / Task 5. ✓
- No gaps.

**2. Placeholder scan:** No "TBD/TODO/fill in". Every code step contains the full YAML. Every command has expected output. The only `REPLACE_WITH_REAL_PAT` is a literal the operator must supply at smoke-test time (inherently user-specific, not a plan gap). ✓

**3. Type/name consistency:** Resource names are consistent across tasks: ConfigMap `renovate-config` (Task 2) ← mounted by CronJob `config` volume (Task 4); Secret `renovate-env` (Task 3) ← `envFrom` (Task 4); PVC `renovate-cache` (Task 3) ← `cache` volume (Task 4); `${SCHEDULE}`/`${LOG_LEVEL}` (metadata Task 1) ← CronJob (Task 4); `substituteFrom: Secret/renovate-config` (metadata Task 1) → `base/secret.yaml` `${RENOVATE_TOKEN}`/`${RENOVATE_GITHUB_COM_TOKEN}` (Task 3). ✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-06-renovate-self-host-app.md`.
