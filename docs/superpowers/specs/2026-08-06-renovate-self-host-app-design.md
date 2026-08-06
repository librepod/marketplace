# Design: Self-hosted Renovate marketplace app

**Date:** 2026-08-06
**Status:** Approved (brainstormed) → pending implementation plan
**App name:** `renovate`

## 1. Goal

Package a **self-hosted Renovate bot** as a generic LibrePod marketplace app, so it
can be installed on any cluster and pointed at any Git platform. This replaces the
motivation for running Renovate as a scheduled GitHub Action (GitHub Actions billing +
GitHub API rate limits on the action's anonymous/changelog lookups) with a self-hosted
runner that uses the operator's own credentials and a persistent cache.

The app must be **generic**: nothing specific to the `librepod/marketplace` repository
(or any particular repo, platform, or update policy) is baked in. Repo-level policy
stays in each target repo's own `renovate.json`, which Renovate reads automatically.

## 2. Non-goals / out of scope

- **Do not touch `.github/workflows/renovate.yaml`.** Decommissioning the existing
  action is a separate decision, made after the self-hosted bot is validated.
- No multi-tenant / per-team isolation. One app instance = one Renovate configuration
  + one platform token.
- No Renovate "server mode" (long-running Deployment with internal queue). We use the
  canonical batch CronJob shape.
- No inbound networking: no `Service`, no `IngressRoute`, no `BASE_DOMAIN`. Renovate is
  outbound-only (clone repos, open PRs).
- No web UI or dashboard surfaced to the user (Renovate's dependency dashboard lives in
  the target Git platform as an issue, not in-cluster).

## 3. Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Platform scope | **Multi-platform capable** | `platform`/`endpoint` live in user config, not hardcoded. Defaults work for github.com; user can point at GHE / GitLab / Gitea / Bitbucket by editing config.json. |
| Config model | **Bring-your-own `config.json`** | App is a pure runner; a ConfigMap holds a full Renovate `config.json` the user edits. Maximally generic, faithful to upstream self-hosting docs. |
| Deployment shape | **CronJob + persistent cache PVC** | Canonical upstream pattern. Persistent cache reduces repeated API calls → directly serves the rate-limit motivation. |
| GH Action fate | **Build app only; leave action alone** | Verify the new bot works before retiring the action. |
| Operational params | **Two optional params: `SCHEDULE`, `LOG_LEVEL`** | These are operational knobs (k8s-side cadence + verbosity), not VCS policy, so they don't dilute "bring-your-own config". Optional with defaults → installer always fills them → `${SCHEDULE}` substitution is never empty. |

## 4. Architecture

```
            ┌───────────────────────────────┐
            │   CronJob (batch/v1)          │   schedule: ${SCHEDULE} (default @hourly)
            │   concurrencyPolicy: Forbid   │   restartPolicy: Never
            │   image: renovate/renovate:   │
            │          44.14.1              │
            └──────────────┬────────────────┘
                           │
        ┌──────────────────┼──────────────────┬───────────────┐
        ▼                  ▼                  ▼               ▼
 ┌─────────────┐   ┌──────────────┐   ┌──────────────┐  ┌──────────────┐
 │ ConfigMap   │   │ Secret       │   │ emptyDir     │  │ PVC (cache)  │
 │ config.json │   │ RENOVATE_    │   │ /tmp/renovate│  │ /tmp/renovate│
 │ (user-      │   │   TOKEN      │   │ (ephemeral   │  │   /cache     │
 │  editable)  │   │ (+ optional  │   │  clones)     │  │ (persistent, │
 │             │   │   GH_COM_TOK)│   │              │  │  nfs-client) │
 └─────────────┘   └──────────────┘   └──────────────┘  └──────────────┘
   mounted at        envFrom            mounted at        mounted at
   /opt/renovate/                       /tmp/renovate     /tmp/renovate/cache
   config.json
```

**Data flow per run:** CronJob fires → container starts → reads `config.json` (ConfigMap)
+ token (Secret env) → Renovate connects to the configured platform, clones target repos
into the ephemeral workdir, consults/writes the **persistent cache** for datasource +
changelog lookups, opens/updates PRs per each repo's own `renovate.json`, then exits.

## 5. File layout

```
apps/renovate/
├── metadata.yaml
├── base/
│   ├── kustomization.yaml
│   ├── namespace.yaml          # Namespace: renovate
│   ├── secret.yaml             # plain Secret, ${VAR} stringData (NOT secretGenerator)
│   ├── configmap.yaml          # default config.json
│   ├── pvc.yaml                # cache PVC (nfs-client, 5Gi)
│   └── cronjob.yaml            # the runner
└── overlays/librepod/
    └── kustomization.yaml      # resources: ../../base
```

No `overlays/librepod/ingressroute.yaml` — this app has no ingress.

## 6. Resource details

### 6.1 `namespace.yaml`
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: renovate
```

### 6.2 `configmap.yaml` (default `config.json` — user replaces/edits)
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
Notes:
- `platform`/`endpoint` default to github.com. For GHE/GitLab/Gitea, user sets `endpoint`
  (e.g. `https://gitlab.example.com/api/v4`) and matching `platform`.
- `autodiscover: false` + empty `repositories` → **the bot does nothing until the user
  adds at least one repo or flips autodiscover**. This is intentional and safe: a freshly
  installed generic bot must not act on anything by default.
- Renovate-level `schedule`/rules are intentionally absent — those live in each repo's own
  `renovate.json`.

### 6.3 `secret.yaml` (plain Secret, `${VAR}` stringData)
```yaml
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
Per the documented LibrePod gotcha: this MUST be a plain Secret (not a `secretGenerator`),
because kustomize base64-encodes secretGenerator output *before* Flux's text substitution,
leaving `${VAR}` literal. Plain `stringData` stays readable so Flux can substitute. Same
pattern as `apps/frpc/base/secret.yaml` and `apps/seafile/base/secret.yaml`.

### 6.4 `pvc.yaml` (persistent cache)
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: renovate-cache
  namespace: renovate
spec:
  accessModes: ["ReadWriteMany"]   # nfs-client supports RWX
  storageClassName: nfs-client
  resources:
    requests:
      storage: 5Gi
```

### 6.5 `cronjob.yaml`
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: renovate
  namespace: renovate
spec:
  schedule: "${SCHEDULE}"            # default @hourly (param)
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
            runAsUser: 12021         # renovate/renovate runs as UID 12021 (ubuntu), gid 0 (verified)
            fsGroup: 12021           # added as supplementary group so PVC/emptyDir are writable
            seccompProfile:
              type: RuntimeDefault
          containers:
            - name: renovate
              # renovate: datasource=docker depName=renovate/renovate
              image: renovate/renovate:44.14.1
              env:
                - name: LOG_LEVEL
                  value: "${LOG_LEVEL}"      # default info (param)
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
Notes:
- The `# renovate: datasource=docker depName=renovate/renovate` comment lets the bot
  self-update its own image tag once installed (same convention as other apps' image refs).
- `concurrencyPolicy: Forbid` + `restartPolicy: Never`: one run at a time; a failed run
  just waits for the next schedule (no infinite restart loop).
- emptyDir `work` = fresh repo clones each run (avoids stale working copies); PVC `cache` =
  Renovate's datasource/changelog cache persists across runs (the rate-limit win).
- **Verified:** `renovate/renovate:44.14.1` runs as UID 12021 (ubuntu), gid 0. The
  container's primary gid is 0 but `fsGroup: 12021` adds 12021 as a supplementary group so
  the emptyDir/PVC mounts are group-writable. **The remaining risk to validate at impl is
  NFS + fsGroup**: nfs-client PVCs don't always honor k8s `fsGroup` chown (depends on the
  server's `all_squash`/`anonuid` mapping). The smoke test (§9.5) explicitly checks for
  `EACCES` on `/tmp/renovate/cache`; if NFS squashes to a different uid, fall back to
  either matching the NFS anonuid or switching the cache to an emptyDir (trading the
  persistence win).

### 6.6 `base/kustomization.yaml`
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - secret.yaml
  - configmap.yaml
  - pvc.yaml
  - cronjob.yaml
```

### 6.7 `overlays/librepod/kustomization.yaml`
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
```

## 7. `metadata.yaml`

```yaml
apiVersion: marketplace/v1
kind: AppDefinition
metadata:
  name: renovate
spec:
  displayName: "Renovate"
  description: "Self-hosted Renovate dependency-update bot. Runs on a schedule and opens
    PRs on your Git repositories (GitHub, GitLab, Gitea, Bitbucket, GHE). Bring your own
    config: point it at your platform + repositories via the config.json ConfigMap and a
    personal access token. No inbound networking required."
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
        description: "Cron schedule for Renovate runs (standard 5-field cron or '@hourly'/'@daily')."
        type: string
        default: "@hourly"
        example: "0 */2 * * *"
      - name: LOG_LEVEL
        description: "Renovate log level."
        type: string
        default: "info"
        example: "debug"

  secrets:
    - name: RENOVATE_TOKEN
      description: "Personal Access Token (or GitHub App token) for the target Git platform. Requires repo + pull-request + issues (dashboard) scopes."
      required: true
    - name: RENOVATE_GITHUB_COM_TOKEN
      description: "Optional PAT for github.com, used to fetch changelogs when the target platform is NOT github.com. Leave empty if targeting github.com."
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

### Substitution / secret flow (matches `apps/litellm` pattern)
1. Installer collects optional params (`SCHEDULE=@hourly`, `LOG_LEVEL=info`) and the
   user-supplied secret `RENOVATE_TOKEN` (required) + optional `RENOVATE_GITHUB_COM_TOKEN`.
2. The `secret:` template renders Secret `renovate-config` in `flux-system` holding the
   token values.
3. The release `postBuild.substitute` injects `SCHEDULE`/`LOG_LEVEL`; `substituteFrom:
   Secret/renovate-config` injects the token values.
4. Flux substitutes `${SCHEDULE}`, `${LOG_LEVEL}` (in the CronJob) and `${RENOVATE_TOKEN}`,
   `${RENOVATE_GITHUB_COM_TOKEN}` (in `base/secret.yaml`) at deploy time.

## 8. Security considerations

- Self-hosted Renovate runs build tooling and consumes arbitrary repo config under a
  trust relationship. For a generic marketplace app this is the operator's responsibility
  — surfaced in the description. The bot only acts on repos the operator explicitly lists
  (autodiscover defaults to `false`).
- Container runs `runAsNonRoot` with the image's UID 1000; `seccompProfile: RuntimeDefault`.
- The platform token lives only in a Kubernetes Secret (never in the ConfigMap/config.json).
- The cache PVC may contain cloned repo metadata; it is in the app namespace and pruned
  with the app on uninstall.

## 9. Validation / testing plan

1. **Local render:** `flux build kustomization marketplace-renovate --path ./apps/renovate/overlays/librepod --local-sources GitRepository/flux-system/librepod-apps=./` → confirm all resources render, `${...}` resolved.
2. **Schema:** pipe rendered output through `kubeconform` (CRD catalog location per `docs/FLUX_WORKFLOW.md`).
3. **Substitution check:** run with `flux build --dry-run` style verification that `SCHEDULE`/`LOG_LEVEL`/token vars resolve (per the `flux-substitute-default-semantics` and `flux-substitute-gotcha` memories).
4. **Dry-run smoke (optional, dev cluster):** set `config.json` `dryRun: "full"` + one throwaway repo, suspend + direct-apply (per `dev-cluster-app-testing-flow` memory: these app manifests are plain kustomize, testable by direct apply once the OCI artifact exists — or via the feature-branch GitRepository patch flow).
5. Confirm the Job pod starts, logs `LOG_LEVEL` output, and exits cleanly with no
   `EACCES` on `/tmp/renovate/cache` (validates the UID/PVC writability assumption).

## 10. Items to verify at implementation time (not placeholders — concrete checks)

- **Renovate logo URL**: RESOLVED — `https://docs.renovatebot.com/assets/images/logo.png`
  (returns 200 image/png). Use that in `metadata.yaml`.
- **Image UID**: RESOLVED — `renovate/renovate:44.14.1` runs as UID 12021 (ubuntu), gid 0.
  `runAsUser: 12021`, `fsGroup: 12021`. The open risk is NFS+fsGroup honoring (see §6.5),
  validated by the §9.5 smoke test.
- **`optional` params + `default`**: confirmed against `apps/frpc`/`apps/wg-easy`
  (`params: optional:` with `default:`). Re-confirm the installer fills defaults so
  `${SCHEDULE}` is never empty via `flux build --dry-run`.
- **Optional secret**: confirm `required: false` on a `secrets:` entry is accepted by the
  installer schema (pattern: `frpc` uses `required: true`; verify the false case renders an
  empty-but-present Secret key).
- **`dependsOn: storage`**: confirm `storage` is the correct Kustomization name for the
  nfs provisioner in this cluster (other apps use `dependsOn: [storage]`).
- **Catalog regeneration**: do NOT hand-edit `catalog.yaml`; the `publish-catalog.yaml` CI
  regenerates it on `apps/*/metadata.yaml` change (per `catalog-update-gap` memory).
