---
card: t_43b7c637
stage: spec
status: pending-approval
app: jellyfin
created: 2026-10-20
next: sdlc/t_ce5a705b/plan.md (card t_1f6bebae) — gated on maintainer approval of this spec
---

# Spec: Jellyfin marketplace app

Parent intent: `sdlc/t_ce5a705b/intent.md` (accepted 2026-10-20). Conventions
below follow the repo's canonical `.claude/skills/librepod-app/SKILL.md` —
where any sibling app differs, the skill wins.

## 1. Identity

- **Slug / namespace / name**: `jellyfin` (matches upstream; DNS-label safe)
- **App type**: Kustomize (upstream publishes container images and compose
  files only — no official Helm chart)
- **Image**: `jellyfin/jellyfin` (Docker Hub, official, multi-arch amd64+arm64)
- **Category**: `Media` (same as Immich)
- **Website**: https://jellyfin.org/

### Image tag policy — DECISION FOR REVIEW

Pin an **exact stable tag** in the overlay (`images[].newTag`), never
`latest` and never a major-floating tag (`10.11`), both of which silently
roll clusters past the advertised `spec.version`. Renovate annotation on
`spec.version` (Kustomize-type pattern, as whoami/wg-easy):

```yaml
# renovate: datasource=docker depName=jellyfin/jellyfin
# serge: notesRepo=jellyfin/jellyfin
version: "<pinned-tag>"
```

Which line to pin — the open call for PR review (see concern C1):

| Option | Tag | Notes |
|---|---|---|
| **A (recommended)** | `12.2` | Current stable line (released 2026-10-05). New app in Oct 2026 should not ship the previous major. |
| B | `10.11.11` | Previous-major maintenance line; last image push 2026-06-06. Fallback if review finds 12.x container regressions. |

Upstream versioning note: 12.x stable tags are plain `12.2` (multi-arch) with
arch-suffixed and dated variants; `unstable`/date-tags (`2026101910`) are
never to be used.

## 2. Runtime shape

- **Port**: 8096/tcp (`http`) — web UI + API on one port
- **Service**: ClusterIP, port 80 → targetPort `http`
- **Probes**: HTTP `GET /health` on `http` (upstream health endpoint):
  startupProbe (generous: first boot runs migrations on NFS; failureThreshold
  30 × 10s), readiness + liveness (period 10s, failureThreshold 3)
- **Env**: none required by upstream. `base/jellyfin.env` carries the single
  tuned default `TZ=UTC` (convention requires the envs file →
  configMapGenerator → envFrom chain)
- **Resources** (concern C4):
  - requests: cpu 100m, memory 512Mi
  - limits: cpu "2", memory 4Gi
  - Rationale: idle Jellyfin is light; library scans and especially software
    transcoding are bursty. 4Gi covers one concurrent software transcode.
- **Strategy**: `Recreate`, replicas 1 (three RWO PVCs forbid rolling)
- **Security context**: none in v1 — official image's entrypoint handles its
  own user; no PUID/PGID env exists upstream (that is the linuxserver fork)

### Storage

Three PVCs, all `ReadWriteOnce`, `storageClassName` patched to `nfs-client`
in the overlay (base stays portable):

| PVC | Mount | Size | Purpose |
|---|---|---|---|
| `jellyfin-config` | `/config` | 1Gi | Metadata, user DB, library db |
| `jellyfin-cache` | `/cache` | 10Gi | Transcode scratch — safe to lose (concern C5: NFS is slow scratch) |
| `jellyfin-media` | `/media` | 100Gi | Default media library (concern C2) |

### Networking — IngressRoute

- Host: `` Host(`jellyfin.${BASE_DOMAIN:=libre.pod}`) ``, entryPoints
  `web` + `websecure`, no `tls:` block (Decision Log #2 — Traefik default
  cert), Service port 80.
- **No oauth2-proxy middlewares.** This is a deliberate, app-specific
  exception (documented inline in the app): Jellyfin is consumed by rich
  non-browser clients (TV apps, mobile, Kodi) that cannot complete an
  oauth2-proxy forward-auth redirect — fronting it with SSO breaks the
  product's primary use. The app has its own user management and first-run
  wizard. Future option (not v1, concern C6): OIDC via the community
  `jellyfin-plugin-sso`, which configures post-install in `/config`.
- UDP 7359 (client discovery) and UDP 1900 (DLNA) are NOT exposed in v1:
  both are LAN broadcast protocols; from a pod netns they cannot reach LAN
  clients without `hostNetwork`, which Decision Log #4 discourages (concern
  C3). Clients enter the server address manually — standard for Jellyfin
  behind any proxy.

## 3. SSO decision

**None.** No `oauth2-proxy` middleware, no `SSOClient` CR, no `casdoor` in
`dependsOn`/`dependencies` (rationale in §2). This matches the intent's
"Jellyfin has native auth; likely no SSO" and the acceptance note that we do
nothing beyond software installation.

## 4. Settings / secrets

**Zero settings items, `allowCustom` absent (closed).** Jellyfin has no
required credentials — the first-run wizard creates the admin account
in-band. With no settings there is no `externalsecret.yaml` and no OpenBao
entry; the install dialog never opens → **one-click install**.

## 5. File manifest

```
apps/jellyfin/
├── metadata.yaml
├── base/
│   ├── kustomization.yaml        # ns+labels (includeSelectors), configMapGenerator envs: jellyfin.env,
│   │                             # resources: namespace, pvc, service, deployment
│   ├── namespace.yaml
│   ├── deployment.yaml           # image jellyfin/jellyfin (NO tag), port http/8096, envFrom CM,
│   │                             # probes GET /health, resources §2, volumes §2, strategy Recreate
│   ├── service.yaml              # 80 → http
│   ├── pvc.yaml                  # multi-document: config 1Gi, cache 10Gi, media 100Gi
│   └── jellyfin.env              # TZ=UTC
└── overlays/librepod/
    ├── kustomization.yaml        # base + ingressroute; images: jellyfin/jellyfin newTag <pin>;
    │                             # patches: patch-storage-class.yaml (NO target selector —
    │                             # multi-doc patches self-identify by metadata.name)
    ├── ingressroute.yaml         # §2, no middlewares, no tls
    └── patch-storage-class.yaml  # multi-document, one doc per PVC, all nfs-client
```

## 6. metadata.yaml shape

- `displayName: "Jellyfin"`
- `description: "Media server for movies, series and music — streams your library to every device (open-source alternative to Plex)"`
- `icon: https://raw.githubusercontent.com/jellyfin/jellyfin-ux/master/logos/SVG/jellyfin-icon--color-on-light.svg` (verified HTTP 200; jellyfin-ux is the official assets repo per upstream branding docs)
- `version`: the pinned tag from §1
- renovate + serge annotations per §1
- `source`: `oci://ghcr.io/librepod/marketplace/apps/jellyfin`, path `./overlays/librepod`
- no `settings`, no legacy `spec.secrets`/`templates.secret`
- `dependencies.required`: IngressController (traefik), StorageClass (nfs-client / storage)
- `templates.source`: OCIRepository, `ref.tag: "__VERSION__"`
- `templates.release`: Kustomization, `dependsOn: [traefik, storage]`,
  `force: true`, `postBuild.substitute: {BASE_DOMAIN}` only
- `templates.kustomization`: source.yaml + release.yaml

## 7. RU description draft (informational only — per intent acceptance, localization is the vendor's job; recorded for whenever the catalog grows localization)

- displayName: «Jellyfin»
- description: «Медиасервер для фильмов, сериалов и музыки — стриминг вашей коллекции на все устройства (открытая альтернатива Plex)»

## 8. Verification plan (build card)

1. `kustomize build apps/jellyfin/overlays/librepod` passes locally; repo CI
   (validate-apps: kustomize build + kubeconform) green.
2. verify-app e2e on the dev cluster (`.claude/skills/verify-app`): render
   templates from metadata.yaml → Gogs user-apps → Flux reconcile →
   deployment Running, `/health` 200 through Traefik on
   `jellyfin.<dev-domain>`, first-run wizard reachable.
3. After merge: publish-apps CI signs and publishes OCI artifact tags
   `<version>` + `latest` → app installable one-click from marketplace UI.

## 9. Concerns flagged for Alex (C1–C6)

- **C1 — version line**: 12.2 (current stable) vs 10.11.11 (previous major,
  last image June 2026). Recommendation: 12.2. One-line change either way at
  PR. Also relates to transcoding (C-transcoding below): none of it is
  decided pre-PR per the intent acceptance.
- **C2 — media storage model (biggest design call)**: the intent assumed a
  "hostPath media dirs convention as per existing media apps", but **no such
  convention exists in this repo** — there are no media apps yet (Immich is
  photos; the only hostPath uses are a tun device and tailscale state). v1
  proposes a plain `jellyfin-media` PVC (100Gi default on nfs-client).
  True hostPath/NAS media needs a **platform** mechanism an app PR cannot
  provide today: `BASE_DOMAIN`/`DEVICE_IP` are the only substitution
  variables the installer fills, and settings values reach the container
  env only — neither can shape a volume spec. If wanted, spawn a follow-up
  card for the platform (e.g. a `MEDIA_PATH` install parameter → rendered
  into the release), not an app hack.
- **C3 — LAN discovery/DLNA omitted**: accepted v1 limitation (§2). No
  hostNetwork per Decision Log #4.
- **C4 — resource limits**: transcoding is bursty; proposed 100m/512Mi →
  2/4Gi. If review prefers no CPU limit for transcode workloads, adjust at
  PR.
- **C5 — transcode cache on NFS**: `/cache` on nfs-client is functional but
  slow as transcode scratch; acceptable v1, note for reviewers.
- **C6 — SSO**: none in v1 (§3). `jellyfin-plugin-sso` (OIDC) is a possible
  future enhancement; it is configured post-install in `/config`, so it
  would be a docs/UX task, not deploy-time wiring.
- **Transcoding /dev/dri (from intent)**: deferred to PR review per
  acceptance. v1 ships CPU-only; adding `/dev/dri` later is one hostPath
  volume + `runtimeClassName`/udev note on nodes that have a GPU — flagged
  so the build card does NOT wire it.
- **100Gi media PVC default**: placeholder — NFS dynamic provisioning makes
  size a soft quota; reviewers should sanity-check the number.

## 10. Acceptance criteria (for the build card t_1e0e45b1)

- [ ] File manifest §5 complete, conventions per the repo skill (envs file,
      overlay-only tag, overlay-patched storageClass, `__VERSION__` source tag)
- [ ] No middlewares/SSO/casdoor/oauth2 anywhere in the app
- [ ] validate-apps CI green (kustomize build + kubeconform)
- [ ] verify-app e2e green on dev cluster (§8)
- [ ] CI publishes signed OCI artifacts `<version>` + `latest`

## 11. Next stage

On maintainer approval of this spec → promote plan card `t_1f6bebae`
(plan.md at `sdlc/t_ce5a705b/plan.md`), then build `t_1e0e45b1`.
