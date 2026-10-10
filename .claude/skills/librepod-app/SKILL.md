---
name: librepod-app
description: >-
  Use when creating, auditing, fixing, or answering questions about LibrePod
  Marketplace apps (apps/*: Kustomize base/overlay structure, metadata.yaml,
  IngressRoute, HelmRelease, SSO wiring). Applies even if the user hasn't said
  "LibrePod" — working in this repo on those files is enough.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch, WebSearch
---

# LibrePod App Skill

## Invocation

This skill can be invoked with a URL argument:

```
/librepod-app <url>
```

The URL can point to anything useful — a Helm chart README, a self-hosting docs page, a Docker Hub image page, a GitHub repo. The skill fetches it, extracts what it needs, and confirms understanding before creating any files.

### When a URL is provided

1. **Fetch the page** using `curl defuddle.md/<url>` — defuddle.md is a markdown-fetching proxy that strips navigation, ads, and boilerplate from web pages, returning clean Markdown that's much easier to extract structured info from. Falls back to `WebFetch` if that fails.
2. **Extract** from the page:
   - App name and description
   - Container image name and available tags
   - Exposed ports
   - Required environment variables and their defaults
   - Persistent storage paths (volumes)
   - Whether a Helm chart is available (repo URL + chart name + version)
   - Any SSO/OIDC documentation
3. **Confirm with the user** before writing any files — present a summary like:

   > **App**: Gitea  
   > **Image**: `gitea/gitea` — latest stable tag: `1.22.1`  
   > **Port**: 3000 (HTTP)  
   > **Storage**: `/data` (1 volume)  
   > **Env vars**: `APP_NAME`, `RUN_MODE`, `DOMAIN`, ...  
   > **Helm chart**: available at `oci://docker.io/gitea/gitea` v10.x  
   > **SSO**: supports native OIDC via `OAUTH2_*` env vars  
   > **Deployment type**: Helm (chart available) — or Kustomize (direct container)?  
   >
   > Ready to scaffold. Anything to adjust?

   Wait for confirmation before proceeding.

### When no URL is provided

Ask the user for: app name, image, port, storage needs, env vars, secrets needed.

---

## Overview

This skill covers creating LibrePod Marketplace applications using Kustomize. Every app has two layers:
- **base/** — generic, environment-agnostic Kubernetes resources
- **overlays/librepod/** — LibrePod-specific patches (storage class, image tag, ingress)
- **metadata.yaml** — marketplace AppDefinition (how FluxCD installs the app for users)

**`metadata.yaml` is mandatory** — without it the app cannot be installed from the marketplace.

---

## Product philosophy — self-heal, never nag

LibrePod is a consumer product for non-technical users. Nobody is watching `kubectl`; the only human in the loop is an end user who must never be shown an error they cannot act on. **An error surfaced to a user is a design failure.** Design apps and updates so transient problems converge silently through reconciliation:

- **Prefer reconciliation over loud failure.** Where a choice exists between "block or fail fast until a human intervenes" and "Flux retries / recreates until it converges", choose convergence. `force: true` on a Kustomization (standard in `templates.release` and system-app Kustomizations) is the canonical case: an immutable-field conflict is resolved by delete+recreate, not by a stuck `Ready=False` waiting for an operator.
- **Recreation is cheap; user data is not.** Workloads are cattle — Flux may delete and recreate them freely, and NFS-backed PVC contents survive recreation. The only thing that must never be destroyed silently is user data.
- **Absorb ordering races with `dependsOn`, retries, and generous budgets — not fail-fast.** Bootstrap Jobs warn+skip and let the next reconcile retry; HelmReleases use `RetryOnFailure`; health-check timeouts are sized for worst-case convergence (e.g. 35m for user-apps-source) because slow convergence is fine, stuck convergence is not.
- **Error visibly only when reconciliation provably cannot fix it** — i.e. a human decision or a human-supplied credential is required. Everything else must self-heal.

**Reviewing/auditing under this lens:** silent recreation by Flux (`force: true`, TTL+version-annotation Job re-runs, workload delete+recreate) is **not** a defect by itself. The two questions that matter: (1) does reconciliation actually converge to the desired state, and (2) does user data survive the recreation? A design that flaps forever, blocks on a condition that can never become true, or loses data is the bug — not the absence of a loud error.

---

## Authority — this skill is the source of truth

This skill is the **canonical, authoritative specification** of LibrePod app conventions. The templates, naming, field placements, and rules documented here *are* the standard — not one option among several. Treat them as the reference when creating, auditing, or fixing any app.

**Never use a sibling app as an example to repeat.** Do not mine `apps/<other-app>/` for patterns, and do not justify a choice with "app X does it this way" or "follow the same approach as app Y." Sibling apps are disqualified as templates for three reasons:

- **App-specific exceptions** — legitimate, localized deviations documented inline within that app (e.g. non-HTTP exposure, a native-SSO quirk, a distroless image needing special handling). They belong to that app and do not generalize.
- **Drift** — apps written before a convention was finalized may not yet reflect the current standard.
- **Mistakes** — some apps carry outright bugs that pre-date the standard (wrong version tag, mis-scoped patch, mangled substitution).

Copying from a sibling app propagates exceptions, drift, and mistakes instead of the standard.

**Resolution rule:** when a live app's files contradict this skill, **this skill is correct** and the app is what gets fixed. Raise apps *toward* the standard; never lower the standard to match an app. If a deviation is genuinely required for a specific app, document *why* inline within that app alone — it is still never a pattern to repeat elsewhere.

**Dependencies are not style examples.** References to system apps elsewhere in this skill — `traefik`, `storage`/`nfs-provisioner`, `oauth2-proxy`, `casdoor` — name real cluster *dependencies* an app must declare in `dependsOn`/`dependencies`. They describe infrastructure an app relies on, not a stylistic layout to imitate.

---

## App Types

| Type | Base contains | Use when |
|------|--------------|----------|
| **Kustomize** | `deployment.yaml`, `service.yaml`, `pvc.yaml`, `.env` | Direct container deployment |
| **Helm** | `ocirepository.yaml` (or `helmrepository.yaml`), `helmrelease.yaml`, `pvc.yaml` | App has an official Helm chart |

---

## Directory Structure

```
apps/<app-name>/
├── metadata.yaml                          # Marketplace AppDefinition (REQUIRED)
├── base/
│   ├── kustomization.yaml
│   ├── namespace.yaml
│   ├── deployment.yaml                    # Kustomize type only (no image tag)
│   ├── service.yaml                       # Kustomize type only
│   ├── ocirepository.yaml                 # Helm type only (or helmrepository.yaml for HTTP Helm repos)
│   ├── helmrelease.yaml                   # Helm type only
│   ├── pvc.yaml                           # If persistent storage needed
│   ├── externalsecret.yaml                # Both types — pulls install settings from OpenBao (see [Settings](#settings-install-questions--generated-secrets))
│   └── <app-name>.env                     # Environment variables
└── overlays/
    └── librepod/
        ├── kustomization.yaml
        ├── ingressroute.yaml
        ├── patch-storage-class.yaml       # Patches storageClassName onto PVC
        └── patch-helmrelease.yaml         # Helm type only: values override
```

---

## Base Layer

### `base/kustomization.yaml` (Kustomize type)

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: <app-name>

labels:
- includeSelectors: true
  includeTemplates: true
  pairs:
    app.kubernetes.io/name: <app-name>

configMapGenerator:
- name: <app-name>
  envs:
  - <app-name>.env

resources:
- namespace.yaml
- pvc.yaml          # Only if app needs persistent storage
- service.yaml
- deployment.yaml
```

### `base/kustomization.yaml` (Helm type)

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: <app-name>

labels:
- includeSelectors: true
  includeTemplates: true
  pairs:
    app.kubernetes.io/name: <app-name>

resources:
- namespace.yaml
- ocirepository.yaml
- helmrepository.yaml   # Only if OCI repository not provided by the vendor 
- helmrelease.yaml
- pvc.yaml              # Only if needed
```

### `base/namespace.yaml`

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: <app-name>
```

### `base/deployment.yaml` (Kustomize type)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <app-name>
spec:
  replicas: 1
  strategy:
    type: Recreate
  template:
    spec:
      containers:
        - name: <app-name>
          image: <image-name>        # NO TAG — tag is set in overlay
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: <port>
          envFrom:
            - configMapRef:
                name: <app-name>
```

**No image tag in base.** The overlay sets it via `images[].newTag`.

### `base/service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: <app-name>
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: http
      protocol: TCP
      name: http
```

### `base/pvc.yaml`

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <app-name>-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  # No storageClassName here — patched in by overlay
```

### `base/ocirepository.yaml` or `base/helmrepository.yaml` (Helm type)

Helm charts can be sourced via **OCI** (preferred) or **HTTP Helm repo**. Use whichever the upstream publisher provides.

**Option A — OCI registry** (preferred when available):

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: <app-name>-helm-charts
spec:
  interval: 24h
  url: oci://<chart-registry-url>
  ref:
    # Pin the EXACT chart version. Not a ~semver range: chart patch releases can
    # change the chart's baked appVersion, which would silently roll clusters to
    # app versions metadata.yaml doesn't advertise. Every bump must be a repo
    # change that moves spec.version (and any cross-renderer newTag) with it.
    tag: "<chart-version>"
```

**Option B — HTTP Helm repo** (when the chart is not published as OCI):

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: <app-name>-helm-charts
spec:
  interval: 24h
  url: https://<helm-repo-url>/
```

When using Option B, the chart version is not pinned in the base `HelmRepository` (HTTP repos don't support semver ranges). Instead, pin it in the overlay via `patch-helmrelease.yaml` (see that section below).

### `base/helmrelease.yaml` (Helm type)


```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: <app-name>
spec:
  interval: 12h
  install:
    strategy:
      name: RetryOnFailure      # On failure: retry the install as an upgrade after retryInterval
      retryInterval: 2m         # (alternative to remediation which uninstalls between retries)
  upgrade:
    strategy:
      name: RetryOnFailure      # On failure: retry the upgrade after retryInterval
      retryInterval: 3m
  chart:
    spec:
      chart: <chart-name>                              # The chart name in the Helm repository
      sourceRef:
        kind: HelmRepository                           # or OCIRepository (must match the source type above)
        name: <app-name>-helm-charts
      interval: 12h
  values:
    # Base/default Helm values go here — NEVER image.tag (see "Image versions"
    # under the patch-helmrelease.yaml section below)
```

### `base/<app-name>.env`

```
ENV_VAR_1=value1
ENV_VAR_2=value2
```

**NEVER use `literals:` in configMapGenerator.** Always use `envs:` with `.env` files.

---

## Overlay Layer

### `overlays/librepod/kustomization.yaml` (Kustomize type)

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: <app-name>

resources:
- ../../base
- ingressroute.yaml

images:
- name: <image-name>
  newTag: <version-tag>

patches:
- path: ./patch-storage-class.yaml
  target:
    kind: PersistentVolumeClaim
```

### `overlays/librepod/kustomization.yaml` (Helm type)

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: <app-name>

resources:
- ../../base
- ingressroute.yaml

patches:
- path: ./patch-helmrelease.yaml
  target:
    kind: HelmRelease
- path: ./patch-storage-class.yaml
  target:
    kind: PersistentVolumeClaim
```

### `overlays/librepod/ingressroute.yaml`

**Always use `${BASE_DOMAIN:=libre.pod}` variable substitution** — never hardcode a domain. FluxCD's `postBuild.substitute` injects the real value at deploy time.

Whether to include the OAuth2 forward-auth middlewares depends on the app's SSO support — see the [SSO Configuration](#sso-configuration) section below. The default (most apps) is to include them.

**Default — app does not handle its own auth:**

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: <app-name>
spec:
  entryPoints:
  - web
  - websecure
  routes:
  - kind: Rule
    match: Host(`<app-name>.${BASE_DOMAIN:=libre.pod}`)
    priority: 1
    middlewares:
    - name: oauth2-errors
      namespace: oauth2-proxy
    - name: oauth2-forwardauth
      namespace: oauth2-proxy
    services:
    - name: <app-name>
      port: 80
```

**Exception — app natively handles OIDC/SSO itself:** omit the `middlewares` block entirely (the app validates tokens on its own).

### Custom launch URL

By default the marketplace's "My Apps" launch link points at the app's front-door IngressRoute host with no path. Two independent mechanisms refine this:

**Axis A — opt-in path via annotation.** Add `librepod.org/launch: "<path>"` to the `metadata.annotations` of the IngressRoute that should serve as the app's front door:

```yaml
metadata:
  name: <app-name>
  annotations:
    librepod.org/launch: "/ui"
```

The value is always a **path** (`/`, `/ui`, `/admin`) — never an absolute or external URL. The launch host comes from that specific route's own `Host(...)` rule, so annotating a *different* IngressRoute changes which host gets launched, not just the path. Worked examples:
- **litellm** (`apps/litellm/overlays/librepod/ingressroute.yaml`) — `librepod.org/launch: "/ui"`, same host, subpath.
- **headscale → headplane** (`apps/headscale/components/headplane/ingressroute.yaml`) — `librepod.org/launch: "/admin"`. This is annotated on the *headplane* route, not the `headscale` API route — headplane serves its admin UI under `/admin`, so the launch link lands on headplane's host at `/admin`, bypassing the app's own `/` → `/admin` redirect middleware.

**Axis B — non-launchable, two ways.** An app is treated as non-launchable when *either*:
- It has **no IngressRoute at all** — the marketplace infers "no web UI" from live cluster state, no annotation needed. Its "My Apps" tile still shows, but routes to the detail page (Manage) instead of a launch link. Example: `rustdesk-server-oss` has zero IngressRoutes and needs no changes.
- It has an IngressRoute but that route is annotated `librepod.org/launch: "false"` — an explicit opt-out for a route that must exist for non-browser traffic (an API, a sync endpoint, a metrics scrape) yet serves no launchable UI. Use this when you *can't* just drop the route.

```yaml
metadata:
  name: <app-name>
  annotations:
    librepod.org/launch: "false"   # route stays, but no launch tile
```

A `"false"` opt-out on **any** of an app's routes suppresses the whole app's launch tile — it wins over a `"<path>"` opt-in on a sibling route. Worked example: **obsidian-livesync** (`apps/obsidian-livesync/overlays/librepod/ingressroute.yaml`) exposes only the raw CouchDB sync endpoint (port 5984, no browser UI), so its route is annotated `"false"`.

> **Why this matters:** without the `"false"` opt-out, an app that has **no web UI but still exposes an IngressRoute** (a metrics scrape, a webhook receiver, an API-only endpoint) is treated as launchable and its tile opens that host — likely a dead page. So: drop the route entirely if the non-UI traffic can go another way (e.g. a plain `Service` on the tailnet), otherwise annotate it `"false"`.

> **Prerequisite (both axes):** the launch resolution reads live `traefik.io/ingressroutes` via the marketplace-ui ServiceAccount. That SA's ClusterRole (`apps/marketplace-ui/base/serviceaccount.yaml`) **must** grant `get/list/watch` on `traefik.io/ingressroutes` — without it the read is denied, the service silently returns "no opinion", and *every* app falls back to launching `https://<name>.<domain>` (both axes become inert).

### `overlays/librepod/patch-storage-class.yaml`

The base PVC intentionally omits `storageClassName`. The overlay patches it in:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <app-name>-data  # Must match the PVC name in base/pvc.yaml
spec:
  storageClassName: nfs-client
```

The `name` field must match the actual PVC name. Even though the `target:` selector in `kustomization.yaml` matches by `kind: PersistentVolumeClaim`, Kustomize still uses the name to apply the strategic merge patch to the correct resource. If your app has multiple PVCs, add one patch entry per PVC name.

### `overlays/librepod/patch-helmrelease.yaml` (Helm type)

Strategic merge patch to add LibrePod-specific Helm values and optionally pin the chart version:

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: <app-name>
spec:
  chart:
    spec:
      chart: <chart-name>
      version: "<X.Y.Z>"                                 # Pin the EXACT chart version (required for HTTP Helm repos)
      sourceRef:
        kind: HelmRepository                            # or OCIRepository — must match base source type
        name: <app-name>-helm-charts
      interval: 12h
  values:
    # LibrePod-specific overrides (PVC mounts, ingress config, etc.)
    extraVolumeMounts:
    - name: data
      mountPath: /data
    extraVolumes:
    - name: data
      persistentVolumeClaim:
        claimName: <app-name>-data
```

**Chart version pinning:** For OCI-based charts, the base `OCIRepository` pins the exact `ref.tag`. For HTTP Helm repos, add `chart.spec.version` in this patch — also an exact version (e.g. `1.5.0`), never a `~` range: chart patch releases can change the baked `appVersion` (openbao 0.30.0 bakes 2.7.0, 0.30.2 bakes 2.7.1), and a range silently rolls clusters past the version `metadata.yaml` advertises. No renovate manager covers these pins, so every bump is a deliberate repo change that moves `spec.version` in the same commit.

### Image versions — never override `image.tag` in Helm values

The vendor chart's baked image tag (its `values.yaml` default / `appVersion`) is the **single source of truth** for which app version ships. Never set `image.tag` — in any shape the chart exposes it (`image.tag`, `controllers.*.containers.*.image.tag`, `<component>.image.tag`, …) — in base `helmrelease.yaml` or `patch-helmrelease.yaml` values.

**If upstream releases a newer app version than the pinned chart ships: wait for the chart.** Chart-lag is NOT a reason to override. Bumping the chart pin (Renovate PR or manual) carries the app forward; `spec.version` in `metadata.yaml` then moves in the SAME change to the new chart's baked tag. Keeping them coupled is the whole point — a values override creates a second version anchor that drifts (this repo did it for immich/gatus and removed it again).

**Do NOT add a `# renovate: datasource=docker depName=<app image>` annotation on `spec.version` for Helm-type apps** — it bumps the advertised version past what the chart actually deploys, recreating the drift. (The annotation is correct for Kustomize-type apps, where `images[].newTag` is the deployment pin.) A chart-tracking annotation (`datasource=helm`, or docker pointed at the chart's OCI repo) is correct ONLY when the vendor versions chart and app in lockstep — chart N.N.N ships app N.N.N (external-secrets, cert-manager). On non-lockstep charts it writes chart numbers into an app-version field (openbao: chart 0.30.x / app 2.7.x), and since no datasource tracks `appVersion`, non-lockstep Helm apps get no annotation at all — hand-couple `spec.version` to chart-pin bumps.

**Allowed structural exceptions** — overriding is fine only when the concern is *which image*, not *which version*, and each requires an inline comment in that app explaining why:

| Exception | Shape | Real example |
|---|---|---|
| Fork / alternative image **repository** | swap `repository`, tag tracks the fork's releases | `frp-operator` → `ghcr.io/librepod/frp-operator` |
| Dead upstream registry reference | replace `repository` (and tag) with a working mirror | `step-issuer` kube-rbac-proxy (smallstep/step-issuer#335) |
| One binary version across Helm-rendered AND Kustomize-rendered resources | the chart value is one spoke of a multi-file contract | `step-certificates` step-ca `0.29.0` ×5 files |

**End-user escape hatch:** an install-time image-tag override (poweruser parameter) is a planned marketplace feature. It is the user's lever, never a repo-side values edit — do not pre-wire `${...}` placeholders for it (chart defaults are literal tags, so substitution cannot fall back to the chart default).

---

## `metadata.yaml` — AppDefinition (REQUIRED)

Every app **must** have `metadata.yaml`. This is how the marketplace knows the app exists and how to install it.

```yaml
apiVersion: marketplace/v1
kind: AppDefinition
metadata:
  name: <app-name>
spec:
  displayName: "<Human-readable Name>"
  description: "<One-line description>"
  icon: "<URL to icon>"
  category: "<Category>"         # e.g. Security, Productivity, Development
  website: "<upstream URL>"

  version: "<upstream app version>"   # e.g. "2.353.0" — ALWAYS the application version actually deployed, never the Helm chart version.
                                      # Kustomize type: the overlay's images[].newTag. Helm type: the pinned chart's baked
                                      # image tag / appVersion — derived, not independent (see "Image versions" above);
                                      # move spec.version and the chart pin in the same change, and keep any renovate
                                      # annotation OFF it (a docker-datasource annotation would drift it past the chart).

  source:
    type: oci-kustomize
    url: "oci://ghcr.io/librepod/marketplace/apps/<app-name>"
    path: ./overlays/librepod

  # Install questions + machine-generated secrets (full contract in the
  # [Settings](#settings-install-questions--generated-secrets) section below). Only questions the app actually asks
  # live here — LibrePod's tuned defaults stay in the app's `.env`
  # (one owner per variable, never both). `BASE_DOMAIN` is reserved.
  settings:
    # allowCustom: true             # Only when users may add free-form env vars (default: closed)
    items:
      - name: SETTING_NAME           # The env var / secret key the app consumes
        label: "Human-readable label"
        description: "What this setting controls"
        type: string                 # string | boolean | number (optional; string if omitted)
        default: "value"             # Optional pre-filled answer
        required: false
        sensitive: false             # UI masking only — storage is identical either way
      - name: MACHINE_SECRET         # Generated at install, never shown in the dialog
        sensitive: true
        generate:
          length: 64                  # Random hex of this length

  dependencies:
    required:
      - kind: IngressController
        description: "Traefik (provided by traefik app)"
      - kind: StorageClass                   # Only if app uses PVC
        description: "nfs-client (provided by nfs-provisioner app)"

  templates:
    source: |
      apiVersion: source.toolkit.fluxcd.io/v1
      kind: OCIRepository
      metadata:
        name: marketplace-<app-name>
        namespace: flux-system
        labels:
          marketplace.io/managed: "true"
          marketplace.io/app: "<app-name>"
      spec:
        interval: 10m
        url: oci://ghcr.io/librepod/marketplace/apps/<app-name>
        ref:
          tag: "<version>"
    release: |
      apiVersion: kustomize.toolkit.fluxcd.io/v1
      kind: Kustomization
      metadata:
        name: marketplace-<app-name>
        namespace: flux-system
        labels:
          marketplace.io/managed: "true"
          marketplace.io/app: "<app-name>"
      spec:
        dependsOn:
          - name: traefik              # Add traefik if app exposes a service to access via browser i.e. ingressroute
          - name: storage              # Add if app uses PVC. "storage" is the Flux Kustomization name (the nfs-provisioner app), not the app dir name.
        force: true                    # Force instructs the controller to recreate resources when patching fails due to an immutable field change.
        interval: 1h
        retryInterval: 2m
        timeout: 5m
        sourceRef:
          kind: OCIRepository
          name: marketplace-<app-name>
        path: ./overlays/librepod
        prune: true
        wait: true
        postBuild:
          substitute:
            BASE_DOMAIN: "${BASE_DOMAIN}"
    kustomization: |
      apiVersion: kustomize.config.k8s.io/v1beta1
      kind: Kustomization
      resources:
        - source.yaml
        - release.yaml
```

> **Self-built apps (marketplace-ui, casdoor-sso-controller) have TWO versions.**
> These two apps are built by LibrePod from source colocated in this monorepo
> (`ui/`, `casdoor-sso-controller/`), not from a vendor image. They therefore
> carry two independent versions:
>
> 1. **Product version** — what the code IS. Authored in the product tree
>    (`ui/package.json` `"version"`; `casdoor-sso-controller/Makefile` `VERSION`).
>    Drives the Docker **image** build + tag. A bump here is a change under the
>    product's CI trigger path, so the image always gets built.
> 2. **Marketplace pin** — `apps/<name>/metadata.yaml` `version:`. A deliberately
>    promoted pointer to a *blessed, tested* product version. Drives the OCI
>    **manifest** tag, `__VERSION__` substitution, the overlay's
>    `images[].newTag`, and `infrastructure/system-apps/<name>.yaml` `ref.tag`.
>    Bump it by hand only when promoting a build; it need not be the latest.
>
> When releasing one of these apps: bump the **product version** first (builds
> the image), then bump the **pin** to that version once it's tested. CI guards
> against pinning an image tag that was never built.

**Key points about `metadata.yaml`:**
- `templates.source` — the OCIRepository FluxCD creates to pull the app artifact
- `templates.release` — the Kustomization FluxCD applies to install the app; `postBuild.substitute` injects `BASE_DOMAIN` (the only substituted variable) so placeholders like `${BASE_DOMAIN:=libre.pod}` in `ingressroute.yaml` and `.env` are resolved. Settings and secrets do NOT ride substitution — they reach the app via OpenBao + ESO (see [Settings](#settings-install-questions--generated-secrets))
- `templates.secret` + `spec.secrets` — **legacy** (see [Secrets](#secrets-legacy--no-new-apps)); never add them to a new app
- `templates.kustomization` — wires source + release together
- `dependsOn` in the release must list all apps from `dependencies.required`

**Important — two different "kustomization" concepts:**
The `overlays/librepod/kustomization.yaml` file in each app is a plain **Kustomize** config (`kustomize.config.k8s.io/v1beta1`) — it has no `postBuild` field. Variable substitution happens in the **FluxCD Kustomization** CRD (`kustomize.toolkit.fluxcd.io/v1`) defined in `templates.release` above. These are two completely different resource types that happen to share a name.

---

## SSO Configuration

**Always research SSO support before writing any config.** Use `WebSearch` or `WebFetch` to check the app's documentation for OIDC/OAuth2/SSO support.

### Decision flow

```
Does the app natively support OIDC/OAuth2/SSO?
├── YES → configure via env vars / Helm values (Case 1)
│         omit oauth2-proxy middlewares from IngressRoute
└── NO  → inform user, use oauth2-proxy forward-auth (Case 2)
          add oauth2-proxy middlewares to IngressRoute
```

**Only ask the user** if documentation is unclear or ambiguous about SSO support.

### Case 1 — Native OIDC support

Configure the app's OIDC settings in `.env` (Kustomize) or `patch-helmrelease.yaml` (Helm). Common env var names vary by app — check the docs. Typical shape:

```
OIDC_ISSUER_URL=https://sso.${BASE_DOMAIN:=libre.pod}
OIDC_CLIENT_ID=<app-name>
OIDC_CLIENT_SECRET=<secret>
```

- **Do not** add oauth2-proxy middlewares to `ingressroute.yaml`
- Declare the OIDC env vars the app needs in `metadata.yaml` — `OIDC_CLIENT_SECRET` as a `settings` item with `generate:` (it is a credential; see [Settings](#settings-install-questions--generated-secrets)), any non-secret OIDC var in the `.env`
- Add `casdoor` to `dependsOn` and `dependencies` in `metadata.yaml`

### Case 2 — No native SSO (oauth2-proxy forward-auth)

Use the default `ingressroute.yaml` template with the oauth2-proxy middlewares (shown above). No per-app proxy config is needed — the central oauth2-proxy deployment handles auth for all apps.

- Add `oauth2-proxy` to `dependsOn` in `metadata.yaml` templates:
  ```yaml
  dependsOn:
    - name: traefik
    - name: oauth2-proxy
  ```
- Add to `dependencies.required` in `spec`:
  ```yaml
  - kind: AuthProxy
    description: "oauth2-proxy (provided by oauth2-proxy app)"
  ```

---

## Settings (install questions + generated secrets)

How an app receives credentials and user-chosen configuration. Declare them in `metadata.yaml` under `spec.settings`; at install time the marketplace resolves them and stores the result in **OpenBao**, and the app reads it back via an `ExternalSecret`. Nothing settings-related is committed to git and nothing passes through Flux `${VAR}` substitution.

### The `settings` contract

```yaml
settings:
  allowCustom: true         # Offer the free-form "custom environment variables" section.
                            # Omitted = closed (the default, and right for most apps).
  items:
    - name: VAR_NAME        # The env var / secret key the app consumes
      label: "..."          # Dialog title
      description: "..."    # Dialog help text
      type: string          # string | boolean | number (default string); options: → dropdown
      default: "..."        # Pre-filled answer
      required: false
      sensitive: false      # UI masking only — storage is identical
      generate:
        length: 64          # Machine secret: random hex of this length, never shown in the dialog
```

**Resolution at install (server-side, `resolveSettings`):**

- A **question** (`generate` unset): the user's answer → its `default` → left unset. The dialog hides nothing; `required: true` blocks an install that leaves it empty.
- A **generated item** (`generate` set): never asked. The value already stored in the OpenBao entry → its `default` → a fresh random value. Stored beats default, so a catalog default can never clobber a value NFS data already depends on (the reinstall/NFS-password trap).
- `allowCustom` values are stored alongside; they reach the app the same way (see delivery below), where they **override the app's `.env` defaults** — that is why the default is `false`: custom vars silently override LibrePod's tuned configuration.
- The resolved map **replaces the whole OpenBao entry** and survives uninstall (the entry is kept, like the app's NFS data).

**Rules:**

- **`BASE_DOMAIN` is reserved** — never a question, never a custom variable. It flows to the manifests via `postBuild.substitute`.
- **One owner per variable.** A variable is either a `.env` default or a `settings` item, never both: the `.env` is the tuned default the app ships with, a settings item is a deliberate install question or machine secret. Listing both means the settings value silently shadows the `.env` (the settings Secret is last in `envFrom`).
- Apps whose items are **all `generate:`** and that do not set `allowCustom` remain **one-click** — the install dialog never opens, since generated items are hidden and there is nothing to ask.

### Storage and delivery

**Storage:** one OpenBao KV v2 entry per app — mount `apps`, key `<app>` (API path `/v1/apps/data/<app>`). marketplace-ui writes it during install, before the Gogs commit.

**Delivery (every app, both types):** `base/externalsecret.yaml` — an `ExternalSecret` named `<app>-settings` targeting the Secret `<app>-settings` in the app's own namespace, via `ClusterSecretStore openbao` (which points at the `apps` mount). Standard form:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: <app-name>-settings
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: openbao
  target:
    name: <app-name>-settings
  dataFrom:
    - extract:
        # The full entry is <mount>/<name>; ESO accepts the mount-prefixed key
        # and strips the leading store path.
        key: apps/<app-name>
```

**Exception — one value, two keys:** when a single stored value must appear under two secret keys (seafile: `INIT_SEAFILE_MYSQL_ROOT_PASSWORD` must equal `MYSQL_ROOT_PASSWORD` or the app locks itself out of its own DB after an NFS rebound), `extract` cannot duplicate a key — use an explicit `data:` list whose entries share one `remoteRef.property` so the equality holds by construction.

### Wiring the `<app>-settings` Secret into the app

**Kustomize type — `envFrom`, settings Secret LAST:**

```yaml
envFrom:
  - configMapRef:
      name: <app-name>            # .env defaults
  - secretRef:
      name: <app-name>-settings   # LAST: its values override the .env defaults,
                                  # and custom variables reach the app this way
```

The Secret is non-optional: the pod waits in `CreateContainerConfigError` until ESO has synced it. When an env var name must differ from the settings key, use an explicit `env:` `secretKeyRef` instead (e.g. the bundled postgres takes `POSTGRES_PASSWORD` from key `DB_PASSWORD`, shared with the app).

**Helm type — `valuesFrom` with `targetPath`, and REMOVE the path from inline `values`:**

```yaml
valuesFrom:
  - kind: Secret
    name: <app-name>-settings
    valuesKey: OLLAMA_ENABLED
    targetPath: ollama.enabled
```

Inline `values` merge **after** `valuesFrom`, so a key present in both makes the inline value win and the question inert — delete the path from `values` when you add it here. Booleans are safe through `valuesFrom` (helm-controller YAML-parses each value). To also put every settings key in the container environment (so `allowCustom` variables reach a Helm app the way they reach a Kustomize app), add the Secret via the chart's `extraEnvFrom` (or equivalent) in the same patch.

**Config-file-driven apps (frp-style):** reference the env var with the consumer's runtime templating — `{{ .Envs.VAR }}` in the config file — and load the Secret via `envFrom`. The committed config stays value-free; the process expands it at startup.

**Shell scripts and probes:** reference credentials braceless — `$VAR`, never `${VAR}`. Flux `postBuild.substitute` rewrites `${VAR}` in all manifest content including ConfigMap data and blanks unknown variables; `$VAR` is invisible to it and the shell resolves it from `envFrom` at runtime. A ConfigMap'ed script that legitimately needs braced/parameter shell expansion must carry the `kustomize.toolkit.fluxcd.io/substitute: disabled` annotation.

### Verifying a settings-consuming app

Manual `kubectl` verification must **seed OpenBao first** — put at least the keys the app consumes into its entry, or the pod sits in `CreateContainerConfigError` until ESO syncs. Use the root token from `Secret openbao-credentials` (key `root-token`, namespace `openbao`) to exec `bao kv put` in the `openbao-0` pod:

```bash
TOKEN=$(kubectl --kubeconfig ~/.kube/librepod-dev.config -n openbao \
  get secret openbao-credentials -o jsonpath='{.data.root-token}' | base64 -d)
kubectl --kubeconfig ~/.kube/librepod-dev.config -n openbao exec openbao-0 -- \
  env BAO_TOKEN="$TOKEN" bao kv put apps/<app-name> KEY1=value1 KEY2=value2
```

(Marketplace installs do this for you — this only matters for hand-applied test deployments.)

### `converge-db-password` is unchanged

The [Bundled PostgreSQL](#bundled-postgresql) rule stands: same container, same script, same failure it prevents. The only change is where `POSTGRES_PASSWORD` comes from — the app's settings Secret (key `DB_PASSWORD`), via `secretKeyRef`, instead of a substituted `${DB_PASSWORD}` secret.

---

## Secrets (legacy — no new apps)

> **Legacy path.** The `spec.secrets[]` + `templates.secret` + `postBuild.substituteFrom` mechanism below is how apps received generated secrets **before settings moved to OpenBao**. It is documented because installed apps still carry it and marketplace-ui still renders a committed `secret.yaml` when a catalog template declares one — **never add it to a new app.** Declared-but-undelivered secrets rot silently: happy-server's committed secret template stopped being delivered, and nothing flagged the gap until the app misbehaved. New apps declare [Settings](#settings-install-questions--generated-secrets).

Apps that need user-supplied secrets (API keys, admin passwords, etc.) declare a **plain `Secret` with `stringData` `${VAR}` placeholders** in `base/secret.yaml`. The real values are generated by the marketplace and injected by FluxCD's `postBuild.substituteFrom` at deploy time (see the `metadata.yaml` wiring below). The committed file holds only `${VAR}` placeholders — never real values.

> **Do not use `secretGenerator` for substitutable secrets.** Kustomize's `secretGenerator` base64-encodes its `data:` fields during build, *before* Flux's `postBuild.substitute` text pass runs — so a `${VAR}` placeholder is encoded (e.g. `${ADMIN_PASSWORD}` → `JHtBRE1JTl9...`) and Flux never sees a literal `${VAR}` to replace. The placeholder survives unchanged and the pod receives the literal string. A plain `Secret` with `stringData` avoids this: `stringData` stays human-readable in the rendered manifest so Flux **can** substitute it, and Kubernetes converts `stringData` → base64 `data` at *apply* time — i.e. after substitution. (A `configMapGenerator` would also be substitutable, but it stores secrets as plaintext — do not use it for real secrets.)

### `base/secret.yaml`

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: <app-name>-secret
type: Opaque
stringData:
  ADMIN_PASSWORD: "${ADMIN_PASSWORD}"
  API_KEY: "${API_KEY}"
```

List `secret.yaml` under `resources:` in `base/kustomization.yaml`. Because it is a plain resource (not a generator), there is **no hash suffix** — the deployment references the literal `<app-name>-secret` name.

### Referencing the secret in the deployment

```yaml
containers:
  - name: <app-name>
    envFrom:
      - configMapRef:
          name: <app-name>
      - secretRef:
          name: <app-name>-secret
```

Use individual `env:` `secretKeyRef` entries instead of (or alongside) `secretRef` when an environment variable name must differ from the secret key, or only a subset of keys is needed.

### `metadata.yaml` wiring

Declare each secret in `spec.secrets` and wire the substituteFrom in `templates.release`:

```yaml
spec:
  secrets:
    - name: ADMIN_PASSWORD
      description: "Admin account password"
      required: true
      generate:
        type: random
        length: 32
```

And in `templates.release`:

```yaml
postBuild:
  substitute:
    BASE_DOMAIN: "${BASE_DOMAIN}"
  substituteFrom:
    - kind: Secret
      name: <app-name>-config
```

Plus add `templates.secret`, whose `stringData` carries the same `${VAR}` placeholders — the marketplace fills it with the generated values, and Flux's `substituteFrom` reads them back to populate `base/secret.yaml` (pre-migration `metadata.yaml` files carry the full shape).

---

## Multiple PVCs

When an app needs more than one persistent volume (e.g., separate data and config directories), define all PVCs in a single `base/pvc.yaml` as a multi-document YAML file:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <app-name>-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <app-name>-config
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

In the overlay `patch-storage-class.yaml`, add one patch document per PVC:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <app-name>-data
spec:
  storageClassName: nfs-client
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <app-name>-config
spec:
  storageClassName: nfs-client
```

And in `overlays/librepod/kustomization.yaml`, patch each by name:

```yaml
patches:
- path: ./patch-storage-class.yaml
  target:
    kind: PersistentVolumeClaim
    name: <app-name>-data
- path: ./patch-storage-class.yaml
  target:
    kind: PersistentVolumeClaim
    name: <app-name>-config
```

Mount both volumes in the deployment:

```yaml
containers:
  - name: <app-name>
    volumeMounts:
      - name: data
        mountPath: /data
      - name: config
        mountPath: /config
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: <app-name>-data
  - name: config
    persistentVolumeClaim:
      claimName: <app-name>-config
```

---

## Init Containers

Use `initContainers` when the app needs setup before the main container starts — common cases include fixing file permissions on mounted volumes, waiting for a dependency to be ready, or running database migrations.

```yaml
spec:
  template:
    spec:
      initContainers:
        - name: fix-permissions
          image: busybox:1.36
          command: ["sh", "-c", "chown -R 1000:1000 /data"]
          volumeMounts:
            - name: data
              mountPath: /data
      containers:
        - name: <app-name>
          # ...
```

For Helm-based apps, check the chart's values for `initContainers` or `extraInitContainers` keys — most charts expose these rather than requiring a patch.

---

## Bundled PostgreSQL

When an app bundles its own database as a sibling Deployment (conventionally `components/postgres/` with its own `deployment.yaml`, `service.yaml`, `pvc.yaml`), two rules apply.

### Rule 1 — `converge-db-password` container is REQUIRED when the password comes from settings

**The failure it prevents:** LibrePod's default storageClass is NFS, and deleting a PVC does not delete the underlying NFS folder — a same-named PVC rebinds to the old data on reinstall. The official postgres image consumes `POSTGRES_PASSWORD` **only at `initdb`** (first boot of an empty data dir). The password the app declares (`DB_PASSWORD` in its settings entry) can therefore differ from what the surviving data dir enforces — an explicit reinstall answer, or an install from before generated values were stored in OpenBao. Result: the app presents a password the old data dir rejects → auth failure (`P1000`-style) → permanent CrashLoopBackOff that no env change can fix.

**The rule:** any Deployment running the official `postgres` image (or a derivative that inherits its entrypoint — e.g. Immich's `ghcr.io/immich-app/postgres`) whose `POSTGRES_PASSWORD` comes from the app's settings Secret (key `DB_PASSWORD`, via `secretKeyRef`) MUST include this container in the same pod:

```yaml
- name: converge-db-password
  image: <same image as the postgres container>
  imagePullPolicy: IfNotPresent
  envFrom:
    - configMapRef:
        name: <same ConfigMap the postgres container loads POSTGRES_* from>
  env:
    - name: POSTGRES_PASSWORD
      valueFrom:
        secretKeyRef:
          name: <app-name>-settings
          key: DB_PASSWORD
  command: ["/bin/sh", "-c"]
  args:
    - |
      until psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c '\q' 2>/dev/null; do
        sleep 1
      done
      printf "ALTER USER %s PASSWORD :'pw';\n" "$POSTGRES_USER" | \
        psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
          -v on_error_stop=1 -v pw="$POSTGRES_PASSWORD"
      while sleep 3600; do :; done
```

It works because the official image's `pg_hba.conf` trusts loopback TCP (127.0.0.1/::1) — and containers in one pod share a network namespace — so the container reaches postgres at `127.0.0.1:5432` as superuser with no password, then converges the stored password to the declared one on every boot. Non-loopback connections (the app's, via the Service) still require scram. Verified on the 16-alpine and 18.4-alpine entrypoints and on Immich's derived image.

**Do not deviate from the script — each of these details fixed a real bug:**

| Detail | Why it's load-bearing |
|---|---|
| `-d "$POSTGRES_DB"` on both psql calls | psql defaults the *database* to the *username* when `-d` is omitted. A superuser without a same-named database (litellm's `llmproxy`) makes the wait-loop spin forever — silently. |
| SQL via `printf \| psql` (stdin), never `-c` | psql does not expand `:'vars'` inside `-c`; the server receives the literal `:'pw'` and errors with `syntax error at or near ":"`. |
| `$VAR` without braces | Flux `postBuild.substitute` rewrites `${VAR}` patterns in all manifest content, including this script. `$VAR` is invisible to it. |
| Same `image:` as the postgres container | The overlay's `images:` transformer pins the tag on every container with that image name — both stay on the same pinned version. |

**When NOT to add it:**
- **Static/hardcoded passwords** (e.g. a password fixed in the env file, never regenerated) — the drift cannot occur, and the container is dead weight.
- **Non-postgres engines** (MariaDB, CouchDB) — different auth mechanics; loopback-trust + `ALTER USER` does not transfer.

### Rule 2 — mount path for postgres ≥ 18

Postgres 18+ images store data in versioned subdirs (`18/docker`) and **hard-error on a PVC mounted at the legacy `/var/lib/postgresql/data` path**. Mount the data volume at `/var/lib/postgresql` instead (matches upstream compose).

---

## Conventions

### ConfigMap — always use generators, never literals

```yaml
# ❌ WRONG
configMapGenerator:
- name: myapp
  literals:
  - DB_HOST=postgres

# ✅ CORRECT
configMapGenerator:
- name: myapp
  envs:
  - myapp.env
```

### Environment variables — envFrom from a generated ConfigMap, never inline literals

Non-secret app config MUST live in a `.env` file consumed by a `configMapGenerator`, and the Deployment loads it via `envFrom`. Inline `env:` with literal `value:`s is non-standard: it hides config from the generated ConfigMap, scatters values across the Deployment, and (for `${VAR}` placeholders) leans on Flux substitution reaching inline values rather than ConfigMap `data`, where it is guaranteed. Flux `postBuild.substitute` DOES reach ConfigMap data, so `${BASE_DOMAIN}` etc. belong in the `.env`.

```yaml
# ❌ WRONG — inline literal env in the Deployment
env:
  - name: DB_HOST
    value: postgres
  - name: APP_URL
    value: "https://myapp.${BASE_DOMAIN}"

# ✅ CORRECT — values in <app-name>.env, loaded via envFrom
#   <app-name>.env:
#     DB_HOST=postgres
#     APP_URL=https://myapp.${BASE_DOMAIN}
envFrom:
  - configMapRef:
      name: <app-name>   # kustomize rewrites this to the generated <app-name>-<hash>
```

Secrets and user settings arrive via the **settings Secret** (`<app>-settings`, synced from OpenBao by ESO — see [Settings](#settings-install-questions--generated-secrets)), referenced via `envFrom` (Secret last) or `secretKeyRef` — never `secretGenerator` (Flux can't substitute its base64 output) and never a plain ConfigMap. A container MAY carry both: `envFrom` for the config ConfigMap plus individual `env:` entries for `secretKeyRef`s.

**Audit rule:** when reviewing an app, check each Deployment container for `env:` entries with a literal `value:`. Any non-secret literal that is not a `secretKeyRef` / `valueFrom` must move to the `.env` → `configMapGenerator` → `envFrom` chain. (Init containers count too.)

### storageClassName — patch in overlay, not base

Base PVC has no `storageClassName`. The `patch-storage-class.yaml` in the overlay adds `nfs-client`. This keeps the base portable.

### Image tag — overlay only (Kustomize type)

Base deployment has `image: nginx` (no tag). Overlay sets `images[].newTag: 1.25-alpine`. Helm-type apps have no equivalent — the chart's baked tag is the version (see "Image versions" under the patch-helmrelease.yaml section).

### Domain — always use variable substitution

```yaml
match: Host(`myapp.${BASE_DOMAIN:=libre.pod}`)
```

The `:=libre.pod` default means the manifest is valid even without substitution.

---

## Verification — Deploy to librepod-dev

After files are created, verify the app is actually deployable by applying it to the live `librepod-dev` cluster. This uses `kubectl` directly — no FluxCD involved.

### Why substitute

Kustomize outputs manifests containing FluxCD variable substitution placeholders like `${BASE_DOMAIN:=libre.pod}`. `kubectl` cannot interpret these — they must be resolved first. Resolve them with explicit `sed` expressions, not `envsubst`: this machine's `envsubst` is not GNU envsubst — it silently ignores its format argument (so `envsubst '${BASE_DOMAIN}'` behaves exactly like bare `envsubst`) and blanks every `${VAR}` it doesn't know, corrupting secret placeholders and `$`-using scripts in ConfigMaps.

### Verification steps

**1. Build and substitute**

```bash
kustomize build ./apps/<app-name>/overlays/librepod \
  | sed -e "s/\${BASE_DOMAIN:=libre.pod}/librepod.dev/g" -e "s/\${BASE_DOMAIN}/librepod.dev/g" \
  | kubectl --kubeconfig ~/.kube/librepod-dev.config apply -f -
```

For Helm-based apps, add `--enable-helm`:

```bash
kustomize build --enable-helm ./apps/<app-name>/overlays/librepod \
  | sed -e "s/\${BASE_DOMAIN:=libre.pod}/librepod.dev/g" -e "s/\${BASE_DOMAIN}/librepod.dev/g" \
  | kubectl --kubeconfig ~/.kube/librepod-dev.config apply -f -
```

The dev cluster's real domain is `librepod.dev` — substituting the `libre.pod` manifest default here causes TLS SAN mismatches. If the app declares `settings`, seed its OpenBao entry first (see [Verifying a settings-consuming app](#verifying-a-settings-consuming-app)) — without it the pod waits in `CreateContainerConfigError` until ESO syncs.

**2. Wait for rollout**

```bash
kubectl --kubeconfig ~/.kube/librepod-dev.config \
  rollout status deployment/<app-name> \
  -n <app-name> \
  --timeout=120s
```

For Helm-based apps check the HelmRelease status instead:

```bash
kubectl --kubeconfig ~/.kube/librepod-dev.config \
  get helmrelease <app-name> -n <app-name> \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
```

**3. Verify pods are running**

```bash
kubectl --kubeconfig ~/.kube/librepod-dev.config \
  get pods -n <app-name>
```

All pods should show `Running` or `Completed`. If any show `CrashLoopBackOff` or `ImagePullBackOff`, check logs:

```bash
kubectl --kubeconfig ~/.kube/librepod-dev.config \
  logs -n <app-name> deployment/<app-name> --tail=50
```

**4. Cleanup — ask the user**

After verification succeeds, ask:

> Verification passed — pods are running in namespace `<app-name>`. Clean up the test deployment now?

If yes:

```bash
kubectl --kubeconfig ~/.kube/librepod-dev.config \
  delete namespace <app-name>
```

If no, leave it running. Note that the namespace now exists on the cluster and FluxCD will adopt it when the app is properly deployed via GitOps.

### Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `unknown field` error on apply | CRD not installed (e.g. `IngressRoute` needs Traefik) | Skip IngressRoute during verification: pipe through `grep -v 'kind: IngressRoute'` before apply, or use `--dry-run=server` |
| `ImagePullBackOff` | Wrong image name or tag | Check `images[].newTag` in overlay |
| `CrashLoopBackOff` | Missing required env var | Check pod logs, add missing var to `.env` |
| App CrashLoops with DB auth failure (`P1000`-style) after reinstall | Rebound NFS volume holds the old password; `POSTGRES_PASSWORD` only applies at `initdb` | Add the `converge-db-password` container — see [Bundled PostgreSQL](#bundled-postgresql) |
| `${VAR}` placeholders blanked in applied manifests | This machine's `envsubst` ignores its format argument and empties unknown `${VAR}`s | Substitute with explicit `sed -e "s/\${VAR}/value/g"` expressions instead of `envsubst` |

---

## Creation Checklist

1. **Gather info**: source app details from the upstream URL/docs (or by asking the user) — app name, image/chart, port, storage needs, env vars, secrets needed. **Never gather conventions/structure from a sibling app under `apps/`; this skill is the only pattern source** (see the Authority section).
2. **Research SSO**: check the app's docs for OIDC/OAuth2/SSO support — native SSO takes priority over oauth2-proxy (see [SSO Configuration](#sso-configuration))
3. **Confirm with user**: present a summary of what will be created (name, image, port, storage, SSO approach, deployment type) and wait for approval before writing any files
4. **Create base**: `namespace.yaml`, `deployment.yaml`+`service.yaml` (or `ocirepository.yaml`+`helmrelease.yaml`), optionally `pvc.yaml`, `.env`, `externalsecret.yaml`, `kustomization.yaml`. If the app bundles a PostgreSQL database with a `DB_PASSWORD` settings item, the postgres Deployment MUST include the `converge-db-password` container (see [Bundled PostgreSQL](#bundled-postgresql))
5. **Create overlay**: `kustomization.yaml` (with image tag or Helm patches), `ingressroute.yaml` (with `${BASE_DOMAIN:=libre.pod}` and SSO middlewares or native OIDC as appropriate), `patch-storage-class.yaml` (if PVC)
6. **Create `metadata.yaml`**: fill AppDefinition, settings, dependencies (including oauth2-proxy or casdoor if needed), all three template blocks
7. **Verify**: deploy to `librepod-dev` using the verification workflow above, confirm pods reach `Running`, ask user about cleanup
8. **Commit and publish**: commit all files under `apps/<app-name>/` to a branch and push. The CI pipeline (`.github/workflows/publish-apps.yaml`) detects changes to any app with a `metadata.yaml` and automatically publishes two OCI artifact tags to GHCR: the version from `metadata.yaml` (e.g. `2.353.0`) and `latest`. Both are Cosign-signed. The app becomes installable from the marketplace once the artifacts are published.

