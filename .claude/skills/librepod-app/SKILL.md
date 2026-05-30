---
name: librepod-app
description: >-
  Use when working with LibrePod Marketplace applications — this covers
  creating new apps, auditing and fixing existing ones, or any question about
  LibrePod app conventions. Trigger on phrases like "add X to the marketplace",
  "scaffold a new app", "I want to self-host Gitea/Nextcloud/anything on
  LibrePod", "create a LibrePod app for...", "validate this app's structure",
  "does this app follow LibrePod conventions", or "fix this app to match the
  standard layout". Use this skill even if the user hasn't explicitly said
  "LibrePod" — if they're working inside this repo and asking about Kustomize
  base/overlay structure, metadata.yaml, IngressRoute, or HelmRelease files,
  this skill applies.
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

resources:
- namespace.yaml
- ocirepository.yaml
- helmrelease.yaml
- pvc.yaml          # Only if needed
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
  selector:
    matchLabels:
      app.kubernetes.io/name: <app-name>
  template:
    metadata:
      labels:
        app.kubernetes.io/name: <app-name>
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
    # Pin minor version, allow patch updates automatically (e.g. 1.2.x → 1.2.99).
    # This lets security/bugfix patches in while keeping you in control of minor/major upgrades.
    # Format: "~<major>.<minor>.0" or equivalently ">=X.Y.0 <X.Z.0"
    semver: "~<major>.<minor>.0"
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
    # Base/default Helm values go here
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
      version: "~<major>.<minor>.0"                     # Pin chart version (recommended for HTTP Helm repos)
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

**Chart version pinning:** For OCI-based charts, the base `OCIRepository` already pins the semver range. For HTTP Helm repos, add `chart.spec.version` in this patch to pin the chart minor version (e.g. `~1.5.0`). This lets patch updates flow in automatically while keeping control of minor/major upgrades.

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

  version: "<upstream app version>"   # e.g. "2.353.0" — ALWAYS the application version (the container image tag), never the Helm chart version. The chart version is an internal detail that lives only in the overlay's patch-helmrelease.yaml.

  source:
    type: oci-kustomize
    url: "oci://ghcr.io/librepod/marketplace/apps/<app-name>"
    path: ./overlays/librepod

  params:
    required:
      - name: BASE_DOMAIN
        description: "Base domain (app will be at <app-name>.BASE_DOMAIN)"
        type: string
        example: "example.com"

  # Only if the app needs user-supplied secrets:
  secrets:
    - name: SECRET_NAME
      description: "What this secret is"
      required: false
      generate:
        type: random
        length: 64

  dependencies:
    required:
      - kind: IngressController
        description: "Traefik (provided by traefik app)"
      - kind: StorageClass                   # Only if app uses PVC
        description: "nfs-client (provided by nfs-provisioner app)"

  templates:
    source: |
      apiVersion: source.toolkit.fluxcd.io/v1beta2
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
          - name: nfs-provisioner      # Add nfs-provisioner if app uses PVC
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
          # Add substituteFrom if app has secrets:
          # substituteFrom:
          #   - kind: Secret
          #     name: <app-name>-config
    # Only if app has secrets:
    # secret: |
    #   apiVersion: v1
    #   kind: Secret
    #   metadata:
    #     name: <app-name>-config
    #     namespace: flux-system
    #   type: Opaque
    #   stringData:
    #     SECRET_NAME: "${SECRET_NAME}"
    kustomization: |
      apiVersion: kustomize.config.k8s.io/v1beta1
      kind: Kustomization
      resources:
        - source.yaml
        - release.yaml
        # - secret.yaml   # Add if app has secrets
```

**Key points about `metadata.yaml`:**
- `templates.source` — the OCIRepository FluxCD creates to pull the app artifact
- `templates.release` — the Kustomization FluxCD applies to install the app; `postBuild.substitute` injects `BASE_DOMAIN` and any secrets into the manifests at deploy time so that placeholders like `${BASE_DOMAIN:=libre.pod}` in `ingressroute.yaml` and `helmrelease.yaml` are resolved
- `templates.secret` — only present when `spec.secrets` is defined; holds user-provided secret values that get injected via `postBuild.substituteFrom`
- `templates.kustomization` — wires source + release (+ secret) together
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
- Add `OIDC_CLIENT_ID` to `params` and `OIDC_CLIENT_SECRET` to `secrets` in `metadata.yaml`
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

## Secrets

Apps that need user-supplied secrets (API keys, admin passwords, etc.) should use a `secretGenerator` in `base/kustomization.yaml`, not a `configMapGenerator`. The secret values themselves come from FluxCD's `postBuild.substituteFrom` at deploy time — the `.env` file in the repo holds only placeholder references.

### `base/kustomization.yaml` with a secret generator

```yaml
configMapGenerator:
- name: <app-name>
  envs:
  - <app-name>.env

secretGenerator:
- name: <app-name>-secret
  envs:
  - <app-name>.secret.env
```

### `base/<app-name>.secret.env`

This file is committed to the repo with placeholder values — the real values are injected by FluxCD at deploy time via `postBuild.substituteFrom`:

```
ADMIN_PASSWORD=${ADMIN_PASSWORD}
API_KEY=${API_KEY}
```

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

Plus add `templates.secret` to hold the Secret resource (see the `metadata.yaml` template above for the full shape).

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

### storageClassName — patch in overlay, not base

Base PVC has no `storageClassName`. The `patch-storage-class.yaml` in the overlay adds `nfs-client`. This keeps the base portable.

### Image tag — overlay only

Base deployment has `image: nginx` (no tag). Overlay sets `images[].newTag: 1.25-alpine`.

### Domain — always use variable substitution

```yaml
match: Host(`myapp.${BASE_DOMAIN:=libre.pod}`)
```

The `:=libre.pod` default means the manifest is valid even without substitution.

---

## Verification — Deploy to librepod-dev

After files are created, verify the app is actually deployable by applying it to the live `librepod-dev` cluster. This uses `kubectl` directly — no FluxCD involved.

### Why `envsubst`

Kustomize outputs manifests containing FluxCD variable substitution placeholders like `${BASE_DOMAIN:=libre.pod}`. `kubectl` cannot interpret these — they must be resolved first. `envsubst` replaces them using shell environment variables, falling back to the `:=default` value if the variable is unset.

### Verification steps

**1. Build and substitute**

```bash
# Set any required variables (BASE_DOMAIN has a default so this is optional)
export BASE_DOMAIN=libre.pod

kustomize build ./apps/<app-name>/overlays/librepod \
  | envsubst \
  | kubectl --kubeconfig ./librepod-dev.config apply -f -
```

For Helm-based apps, add `--enable-helm`:

```bash
kustomize build --enable-helm ./apps/<app-name>/overlays/librepod \
  | envsubst \
  | kubectl --kubeconfig ./librepod-dev.config apply -f -
```

**2. Wait for rollout**

```bash
kubectl --kubeconfig ./librepod-dev.config \
  rollout status deployment/<app-name> \
  -n <app-name> \
  --timeout=120s
```

For Helm-based apps check the HelmRelease status instead:

```bash
kubectl --kubeconfig ./librepod-dev.config \
  get helmrelease <app-name> -n <app-name> \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
```

**3. Verify pods are running**

```bash
kubectl --kubeconfig ./librepod-dev.config \
  get pods -n <app-name>
```

All pods should show `Running` or `Completed`. If any show `CrashLoopBackOff` or `ImagePullBackOff`, check logs:

```bash
kubectl --kubeconfig ./librepod-dev.config \
  logs -n <app-name> deployment/<app-name> --tail=50
```

**4. Cleanup — ask the user**

After verification succeeds, ask:

> Verification passed — pods are running in namespace `<app-name>`. Clean up the test deployment now?

If yes:

```bash
kubectl --kubeconfig ./librepod-dev.config \
  delete namespace <app-name>
```

If no, leave it running. Note that the namespace now exists on the cluster and FluxCD will adopt it when the app is properly deployed via GitOps.

### Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `unknown field` error on apply | CRD not installed (e.g. `IngressRoute` needs Traefik) | Skip IngressRoute during verification: pipe through `grep -v 'kind: IngressRoute'` before apply, or use `--dry-run=server` |
| `ImagePullBackOff` | Wrong image name or tag | Check `images[].newTag` in overlay |
| `CrashLoopBackOff` | Missing required env var | Check pod logs, add missing var to `.env` |
| `envsubst` eating `$` in values | Env vars in `.env` files that use `$` notation | Scope `envsubst` to only known variables: `envsubst '${BASE_DOMAIN}'` |

### Scoping `envsubst` safely

By default `envsubst` replaces **all** `$VAR` occurrences, which can corrupt values that legitimately contain `$`. Scope it to only the variables that FluxCD would substitute:

```bash
kustomize build ./apps/<app-name>/overlays/librepod \
  | envsubst '${BASE_DOMAIN}' \
  | kubectl --kubeconfig ./librepod-dev.config apply -f -
```

Add any additional substitution variables from `metadata.yaml`'s `postBuild.substitute` block to the `envsubst` argument list.

---

## Creation Checklist

1. **Gather info**: if a URL was provided, fetch it and extract app details; otherwise ask the user for app name, image/chart, port, storage needs, env vars, secrets needed
2. **Research SSO**: check the app's docs for OIDC/OAuth2/SSO support — native SSO takes priority over oauth2-proxy (see [SSO Configuration](#sso-configuration))
3. **Confirm with user**: present a summary of what will be created (name, image, port, storage, SSO approach, deployment type) and wait for approval before writing any files
4. **Create base**: `namespace.yaml`, `deployment.yaml`+`service.yaml` (or `ocirepository.yaml`+`helmrelease.yaml`), optionally `pvc.yaml`, `.env`, `kustomization.yaml`
5. **Create overlay**: `kustomization.yaml` (with image tag or Helm patches), `ingressroute.yaml` (with `${BASE_DOMAIN:=libre.pod}` and SSO middlewares or native OIDC as appropriate), `patch-storage-class.yaml` (if PVC)
6. **Create `metadata.yaml`**: fill AppDefinition, params, secrets, dependencies (including oauth2-proxy or casdoor if needed), all four template blocks
7. **Verify**: deploy to `librepod-dev` using the verification workflow above, confirm pods reach `Running`, ask user about cleanup
8. **Commit and publish**: commit all files under `apps/<app-name>/` to a branch and push. The CI pipeline (`.github/workflows/publish-apps.yaml`) detects changes to any app with a `metadata.yaml` and automatically publishes two OCI artifact tags to GHCR: the version from `metadata.yaml` (e.g. `2.353.0`) and `latest`. Both are Cosign-signed. The app becomes installable from the marketplace once the artifacts are published.

