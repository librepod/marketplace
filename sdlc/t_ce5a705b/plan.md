---
card: t_1f6bebae
stage: plan
status: pending-approval
app: jellyfin
created: 2026-10-20
next: build card t_1e0e45b1 (claude-lane, branch claude/t_ce5a705b/<ts> off sdlc/t_ce5a705b)
spec: sdlc/t_ce5a705b/spec.md (t_43b7c637, 72cebb6)
---

# Plan: Jellyfin marketplace app

Implements `sdlc/t_ce5a705b/spec.md`. Everything below is final — exact file
paths and exact contents. The build card executes this top-to-bottom with no
design decisions left open. Repo conventions per `.claude/skills/librepod-app`
(canonical) and sibling precedents: whoami (Kustomize-type exemplar), immich
(multi-PVC patch pattern), gogs (probe shape), casdoor (force: true, storage
dependsOn).

## 0. Locked decisions (from spec; do not relitigate in build)

| # | Decision | Value |
|---|----------|-------|
| D1 | App type | Kustomize (no official Helm chart upstream) |
| D2 | Image / pin | `jellyfin/jellyfin`, exact tag `12.2` (verified on Docker Hub 2026-10-20: multi-arch amd64+arm64, pushed 2026-10-05). Never `latest`, never floating |
| D3 | SSO | **None** — no oauth2-proxy middlewares, no SSOClient, no casdoor. Rich clients (TV/Kodi) can't complete forward-auth redirect; Jellyfin has native users + first-run wizard |
| D4 | Settings/secrets | **Zero** — no `settings:`, no externalsecret, one-click install |
| D5 | Storage | 3 RWO PVCs: config 1Gi, cache 10Gi, media 100Gi; `nfs-client` patched in overlay only |
| D6 | Transcoding | CPU-only in v1; **do NOT wire /dev/dri**, no hostPath, no runtimeClass |
| D7 | Network | IngressRoute only; no UDP 7359/1900, no hostNetwork |
| D8 | Probes | HTTP `GET /health`; startup 30×10s (NFS first boot), ready/live 3×10s |
| D9 | Version metadata | `version: "12.2"` + renovate docker annotation + serge notesRepo |
| D10 | dependsOn | `[traefik, storage]` — storage is the bootstrap nfs provider's Flux name (casdoor/dolt precedent), NOT `nfs-provisioner` |

## 1. Files to create — exact order

All paths relative to repo root. Create in this order (each step's check gates
the next). 9 files, ~230 lines total.

### 1.1 `apps/jellyfin/base/namespace.yaml`

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: jellyfin
```

### 1.2 `apps/jellyfin/base/jellyfin.env`

Upstream needs no env; file exists to satisfy the envs-file convention and
carries the single tuned default from the spec.

```env
# Jellyfin - no required environment variables (first-run wizard in web UI)
# TZ pinned for log/library timestamp consistency; override freely.
TZ=UTC
```

### 1.3 `apps/jellyfin/base/pvc.yaml`

Multi-document, one PVC per doc (immich precedent). **No storageClassName in
base** — patched in overlay. Comment on the media size: NFS dynamic
provisioning treats it as a soft quota (spec C-last).

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: jellyfin-config
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      # Metadata, user DB, library db. Small.
      storage: 1Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: jellyfin-cache
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      # Transcode scratch — safe to lose. NFS is slow scratch (spec C5);
      # move to local/block class if transcoding stutters.
      storage: 10Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: jellyfin-media
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      # Default media library. Soft quota under NFS dynamic provisioning —
      # size to taste (spec flags this default for PR sanity-check).
      storage: 100Gi
```

### 1.4 `apps/jellyfin/base/service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: jellyfin
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: http
      protocol: TCP
      name: http
```

### 1.5 `apps/jellyfin/base/deployment.yaml`

Image **without tag** (overlay sets it). Explicit selector/template labels
(whoami style) — kustomize's `includeSelectors` label transform rewrites them
identically; harmless and robust. Recreate strategy: three RWO PVCs forbid
rolling. No securityContext (spec §2: official entrypoint manages its own
user; PUID/PGID is the linuxserver fork, not upstream).

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jellyfin
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: jellyfin
  template:
    metadata:
      labels:
        app.kubernetes.io/name: jellyfin
    spec:
      containers:
        - name: jellyfin
          image: jellyfin/jellyfin
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 8096
              protocol: TCP
          envFrom:
            - configMapRef:
                name: jellyfin
          resources:
            requests:
              cpu: 100m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 4Gi
          startupProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 10
            failureThreshold: 30
            timeoutSeconds: 5
          readinessProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 10
            failureThreshold: 3
            timeoutSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: http
            periodSeconds: 10
            failureThreshold: 3
            timeoutSeconds: 5
          volumeMounts:
            - name: config
              mountPath: /config
            - name: cache
              mountPath: /cache
            - name: media
              mountPath: /media
      volumes:
        - name: config
          persistentVolumeClaim:
            claimName: jellyfin-config
        - name: cache
          persistentVolumeClaim:
            claimName: jellyfin-cache
        - name: media
          persistentVolumeClaim:
            claimName: jellyfin-media
```

### 1.6 `apps/jellyfin/base/kustomization.yaml`

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: jellyfin

labels:
- includeSelectors: true
  includeTemplates: true
  pairs:
    app.kubernetes.io/name: jellyfin

configMapGenerator:
- name: jellyfin
  envs:
  - jellyfin.env

resources:
- namespace.yaml
- pvc.yaml
- service.yaml
- deployment.yaml
```

Check: `kustomize build apps/jellyfin/base` renders 7 docs (ns, configmap,
3×pvc, service, deployment) and exit 0.

### 1.7 `apps/jellyfin/overlays/librepod/ingressroute.yaml`

**No middlewares** — the deliberate Jellyfin exception (D3). Document inline so
future auditors don't "fix" it. No `tls:` block (repo convention: default cert
on websecure).

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: jellyfin
spec:
  entryPoints:
  - web
  - websecure
  routes:
  # Deliberately NO oauth2-proxy forward-auth middlewares: Jellyfin is
  # consumed by rich non-browser clients (TV apps, mobile, Kodi) that cannot
  # complete an SSO redirect. Jellyfin has native user management and a
  # first-run wizard. Possible future: OIDC via jellyfin-plugin-sso
  # (post-install /config task, not deploy-time wiring).
  - kind: Rule
    match: Host(`jellyfin.${BASE_DOMAIN:=libre.pod}`)
    priority: 1
    services:
    - name: jellyfin
      port: 80
```

### 1.8 `apps/jellyfin/overlays/librepod/patch-storage-class.yaml`

Multi-document, one doc per PVC, **no `target:` selector** in kustomization
(multi-doc strategic-merge patches self-identify by metadata.name — immich
precedent, avoids the kustomize "Multiple Strategic-Merge Patches" error).

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: jellyfin-config
spec:
  storageClassName: nfs-client
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: jellyfin-cache
spec:
  storageClassName: nfs-client
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: jellyfin-media
spec:
  storageClassName: nfs-client
```

### 1.9 `apps/jellyfin/overlays/librepod/kustomization.yaml`

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: jellyfin

resources:
- ../../base
- ingressroute.yaml

images:
- name: jellyfin/jellyfin
  newTag: "12.2"

# No target selector on the storage patch: it is multi-document (one PVC per
# doc) and each doc self-identifies by metadata.name.
patches:
- path: ./patch-storage-class.yaml
```

### 1.10 `apps/jellyfin/metadata.yaml`

AppDefinition. `__VERSION__` in the source template — the installer fills it
from `spec.version`, and publish CI tags the OCI artifact `12.2` + `latest`.
No `settings`, no `secrets`, no oauth2/casdoor dependencies. dependsOn uses
`storage` + `traefik` with `force: true` (casdoor/dolt precedent).

```yaml
apiVersion: marketplace/v1
kind: AppDefinition
metadata:
  name: jellyfin
spec:
  displayName: "Jellyfin"
  description: "Media server for movies, series and music — streams your library to every device (open-source alternative to Plex)"
  icon: "https://raw.githubusercontent.com/jellyfin/jellyfin-ux/master/logos/SVG/jellyfin-icon--color-on-light.svg"
  category: "Media"
  website: "https://jellyfin.org/"

  # renovate: datasource=docker depName=jellyfin/jellyfin
  # serge: notesRepo=jellyfin/jellyfin
  version: "12.2"

  source:
    type: oci-kustomize
    url: "oci://ghcr.io/librepod/marketplace/apps/jellyfin"
    path: ./overlays/librepod

  dependencies:
    required:
      - kind: IngressController
        description: "Traefik (provided by traefik app)"
      - kind: StorageClass
        description: "nfs-client (provided by nfs-provisioner / storage)"

  templates:
    source: |
      apiVersion: source.toolkit.fluxcd.io/v1
      kind: OCIRepository
      metadata:
        name: marketplace-jellyfin
        namespace: flux-system
        labels:
          marketplace.io/managed: "true"
          marketplace.io/app: "jellyfin"
      spec:
        interval: 10m
        url: oci://ghcr.io/librepod/marketplace/apps/jellyfin
        ref:
          tag: "__VERSION__"
    release: |
      apiVersion: kustomize.toolkit.fluxcd.io/v1
      kind: Kustomization
      metadata:
        name: marketplace-jellyfin
        namespace: flux-system
        labels:
          marketplace.io/managed: "true"
          marketplace.io/app: "jellyfin"
      spec:
        dependsOn:
          - name: traefik
          - name: storage
        force: true
        interval: 1h
        retryInterval: 2m
        timeout: 5m
        sourceRef:
          kind: OCIRepository
          name: marketplace-jellyfin
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

## 2. Order of work

1. Branch: build card works in its own worktree on
   `claude/t_ce5a705b/<timestamp>` branched off `sdlc/t_ce5a705b` (NOT
   master).
2. Create files §1.1→§1.6 (base), run base check.
3. Create files §1.7→§1.9 (overlay), run overlay checks §3.2.
4. Create §1.10 metadata.yaml, run §3.3 checks.
5. Run full §3 gate suite; fix until green.
6. Commit everything as ONE commit `feat(jellyfin): add Jellyfin app`
   (mirrors repo style, e.g. `feat(tailscale): …`). Commit message body: one
   paragraph summary + `Spec: sdlc/t_ce5a705b/spec.md · Plan: sdlc/t_ce5a705b/plan.md`.
7. Push branch, open PR **targeting `sdlc/t_ce5a705b`** (stacks onto feature
   branch; feature PR #292 → master picks the commits up). Title
   `Add Jellyfin app`. Leave ready-for-review — **never merge** (Alex merges).
   PR body: links to spec.md/plan.md + card ids t_ce5a705b / t_43b7c637 /
   t_1f6bebae / t_1e0e45b1, and concerns C1–C6 copied from spec §9 for
   merge-time review.
8. Hermes reconciles diff vs plan (reconciliation checklist), reruns §3
   canonical checks itself.

## 3. Test strategy (canonical checks — Hermes reruns these)

### 3.1 Base layer

```
kustomize build apps/jellyfin/base > /tmp/jf-base.yaml
# expect: 7 YAML docs, exit 0
grep -c '^kind:' /tmp/jf-base.yaml   # → 7
# no image tag on jellyfin/jellyfin:
! grep 'image: jellyfin/jellyfin:' /tmp/jf-base.yaml
# no storageClassName in base output:
! grep storageClassName /tmp/jf-base.yaml
```

### 3.2 Overlay layer

```
kustomize build apps/jellyfin/overlays/librepod > /tmp/jf.yaml
grep -c '^kind:' /tmp/jf.yaml        # → 8 (7 + IngressRoute)
grep 'newTag: "12.2"' apps/jellyfin/overlays/librepod/kustomization.yaml
grep 'image: jellyfin/jellyfin:12.2' /tmp/jf.yaml
grep -c 'storageClassName: nfs-client' /tmp/jf.yaml   # → 3
# substitution placeholder must SURVIVE kustomize (Flux postBuild resolves it):
grep 'jellyfin.${BASE_DOMAIN:=libre.pod}' /tmp/jf.yaml
```

### 3.3 Negative gates (spec acceptance criteria)

```
! grep -ri 'oauth2\|middleware\|ssoclient\|casdoor' apps/jellyfin/
! grep -ri 'settings:\|secrets:' apps/jellyfin/metadata.yaml
! grep -ri 'hostPath\|dev/dri\|runtimeClassName\|hostNetwork' apps/jellyfin/
! grep 'newTag' apps/jellyfin/base/   # nothing
```

### 3.4 Rendered-manifest sanity (post-substitution)

**Do NOT use `envsubst`** — repo skill pitfall (`.claude/skills/librepod-app`
"envsubst"): this machine's envsubst leaves `${BASE_DOMAIN:=libre.pod}`
entirely unexpanded (GNU envsubst does not understand `:=` defaults — verified
2026-10-20), so a local `kubectl apply` pipe would deploy a broken host rule.
Use explicit sed, exactly as the repo skill prescribes:

```
kustomize build apps/jellyfin/overlays/librepod \
  | sed -e 's/\${BASE_DOMAIN:=libre\.pod}/libre.pod/g' > /tmp/jf-rendered.yaml
grep 'Host(`jellyfin.libre.pod`)' /tmp/jf-rendered.yaml
# and with a real domain value:
sed -e 's/\${BASE_DOMAIN:=libre\.pod}/dev.example/g' /tmp/jf.yaml | grep 'Host(`jellyfin.dev.example`)'
```

### 3.5 CI parity

validate-apps workflow (kustomize build + kubeconform strict +
`flux build … --dry-run`) runs on the PR via nix-shell — green required.
kubeconform is not on this host; if `nix-shell shell.nix` is available
locally, run it; otherwise CI is the gate. e2e job is placeholder-green
(no `renovate-e2e` label needed).

### 3.6 Cluster verification (QA card, not build)

verify-app skill on librepod-dev (kubeconfig
`~/.kube/librepod-dev.config`): render templates from metadata.yaml → Gogs
user-apps → Flux reconcile → deployment Running, `GET /health` → 200 through
Traefik, first-run wizard reachable. Evidence → `sdlc/t_ce5a705b/qa.md`.
Build card does NOT apply anything to the dev cluster.

## 4. Risks / flags carried to PR (from spec §9 — Alex reviews at merge)

- **C1** version line 12.2 vs 10.11.11 — recommended 12.2, one-line change.
- **C2** media storage is a PVC, not hostPath — no platform mechanism exists;
  follow-up card if wanted. Biggest design call in the PR.
- **C4** resource limits 100m/512Mi → 2/4Gi — CPU limit vs transcode burst.
- **C5** transcode cache on NFS — functional but slow scratch.
- **C6** no SSO — jellyfin-plugin-sso future card.
- `/dev/dri` transcoding deferred — build must NOT wire it.

Plan-specific notes:
- Tag `12.2` and icon URL verified live on 2026-10-20 (Docker Hub multi-arch
  amd64+arm64; HTTP 200). Re-check at build time; if the icon 404s, fall back
  to any official jellyfin-ux logo URL.
- `storage` vs `nfs-provisioner` dependsOn name: `storage` matches casdoor /
  dolt / firefly-iii-telegram-bot. If Flux on dev shows the storage Kustomization
  under a different name, QA adjusts — one word, one place.

## 5. Out of scope (build card must not do)

- No SSO/OAuth of any kind; no settings dialog; no secrets.
- No /dev/dri, GPU, hostPath, hostNetwork, UDP 7359/1900 (DLNA/discovery).
- No RU localization (vendor's job per intent acceptance).
- No edits outside `apps/jellyfin/**` (+ this sdlc/ artifact). No master
  commits. No merges.
