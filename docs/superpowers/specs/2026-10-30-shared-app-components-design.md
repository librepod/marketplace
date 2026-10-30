# Shared App Components — Design

**Date:** 2026-10-30
**Status:** Proposed — revision 2 (replaces the vendored-slots design after review)
**Branch:** `feat/shared-app-components`

## Intent

Advanced users want to bolt optional networking pieces onto an app when they
install it:

- **VPN egress** — route the pod's outbound traffic through a tunnel the user
  brings (gluetun with a WireGuard config, or sing-box with a full config).
  Motivating case: `firefly-iii-telegram-bot` reaching the Telegram API from a
  location where it is blocked.
- **Tailnet membership** — run a tailscale sidecar so the app joins the user's
  tailnet (headscale or Tailscale).
- **Public HTTPS exposure** — publish the app on a subdomain of the FRP relay,
  TLS terminated at the relay.

Today these exist only as app-private kustomize components baked into single
apps — tailscale in `collie` and `remnawave` (two copies that already drifted:
different state storage, DNS, RBAC and image pins), FRP upstreams in `headscale`.
They were baked in only because no shared mechanism existed. This design makes
them one shared, separately versioned library that is composed into an app per
install, in-cluster.

Audience: this is an advanced-user feature. Users decide what they attach and
live with the consequences; the platform does not gate choices. Marking apps as
"one-click" vs "needs setup" (badges) and a dedicated install screen for apps
that need setup are a separate, later feature.

## Goals

1. In the install dialog, a user can pick optional components for an app and
   provide their settings; the app installs with them.
2. Each component exists exactly once in the repo and is versioned and
   published independently of apps.
3. Any installed app version can take any component the app lists — components
   do not ride inside app artifacts.
4. An install pins the component versions it got (like it pins the app tag) and
   that pin is recorded so a future update feature can detect "update
   available".
5. tailscale (collie, remnawave) and the FRP upstream (headscale) are extracted
   into optional shared components; the app-private copies are deleted.

## Non-goals (this story)

- **The update button / update flow.** This story only records versions. A
  separate feature will compare installed vs catalog versions and let the user
  update.
- **Changing components after install** (Manage-page attach/detach). To change
  components, uninstall and reinstall.
- **Editing component settings after install.** Same: reinstall.
- **Casual/advanced app badges and an advanced install screen.**
- **Guarding unsafe choices.** E.g. exposing an app via frp-expose whose only
  login is Traefik's SSO forward-auth puts it on the internet without a login.
  That is the user's call; the UI does not block it.
- **Raw TCP/UDP FRP ports.** v1 frp-expose is HTTPS-subdomain only. wg-easy's
  `components/frp-upstreams` (UDP, not wired into wg-easy today) is left alone.
- **Pod-patching components on apps whose workload lives inside a HelmRelease**
  (e.g. immich). Such apps may list resource-only components (frp-expose) but
  not patch components (gluetun, sing-box, tailscale).
- **Commercial-VPN provider flows for gluetun** (provider env matrices). v1 takes
  a full custom WireGuard config paste.
- **Third-party components.** Components are repo-curated.
- **Cosign verification of user-app OCIRepositories** — a pre-existing gap (no
  app `source` template sets `verify`). Component sources added by this design
  *are* verified; closing the app-source gap is a follow-up.

## Anti-goals (failure even if it "works")

- An app with no components selected depending on source-watcher. Plain
  installs keep today's exact files.
- App-specific copies of component manifests, or app names stamped into
  component manifests at publish time.
- A component's secrets (VPN keys, auth keys) reaching the app container. Apps
  load `<app>-settings` with `envFrom`, so component secrets must never be
  written there.

## Decided by the user

- Composition via Flux **ArtifactGenerator** (fluxcd/source-watcher) combining
  the app artifact with separately published component artifacts (review
  "option B").
- Component versioning mirrors apps: a component's version tracks its *native*
  version (the image it runs); manifest-only changes re-push the **same** tag
  (rolling tag), so installs pinned to that version converge silently. A new
  native version is a new tag, and the future update feature surfaces it.
- Only record versions in this story; the update button is a separate feature.
- Big-bang migration of existing installs; downtime accepted.
- tailscale and frp-expose are extracted into **optional** shared components.
  All components are optional — including frp-expose for headscale.
- frp-expose v1 uses the HTTPS-subdomain route headscale uses today, not raw
  TCP ports.
- No login gate on frp-expose.
- Components are picked **only in the install dialog** in this story.

## Verified facts this design relies on

| Fact | How verified |
|---|---|
| source-watcher runs on dev (v2.2.4) via FluxInstance `spec.components`; flux-operator adds `--feature-gates=ExternalArtifact=true` to kustomize-controller automatically | live dev cluster; flux-operator source (`internal/builder/profiles.go`) |
| ArtifactGenerator has **no** `spec.interval`; it regenerates on source change; the drift interval is the annotation `source.extensions.fluxcd.io/reconcileEvery` (default 1h) | `api/v1beta1/artifactgenerator_types.go`, spec doc |
| Copy `from: "@x/"` copies the source root's *contents* into `to`; later copies overwrite earlier ones | `internal/builder/builder.go` |
| Generated ExternalArtifact revision is `latest@sha256:<content>`; `originRevision: "@app"` keeps the app revision in metadata. Do **not** set `revision: "@app"` (component changes would then not change the revision) | spec doc |
| Generator deletion removes its ExternalArtifacts via finalizer + inventory (not ownerReferences); if source-watcher is down, deletion waits | `artifactgenerator_finalize.go` |
| All 42 catalog apps are `oci-kustomize`, `path: ./overlays/librepod`, and their `release` template is a Flux `Kustomization` | `apps/*/metadata.yaml` |
| Flux `Kustomization.spec.components` takes paths relative to `spec.path`; `..` allowed | kustomize-controller `docs/spec/v1/kustomizations.md` |
| Resources added by a component included at the overlay level inherit the overlay's `namespace:` | local `kustomize build` |
| A component patch with `target.annotationSelector` and a placeholder `metadata.name` patches only the annotated Deployment (a sibling Deployment in the same overlay is untouched) | local `kustomize build` |
| OpenBao policies `apps/data/*` (marketplace-ui write, ESO read) already cover nested paths like `apps/<app>/<component>` | `apps/openbao/overlays/librepod/policies/*.hcl` |
| App settings types are `string \| boolean \| number` — no multi-line type | `ui/packages/shared/src/types.ts` |
| `cosign-pub` Secret exists in `flux-system` wherever system apps verify (they reference it) | `infrastructure/system-apps/*.yaml` |
| gluetun's health server binds `127.0.0.1:9999` (kubelet `httpGet` cannot reach it); its firewall auto-accepts inbound to the pod's own subnet but only allows outbound to that /24 unless `FIREWALL_OUTBOUND_SUBNETS` widens it | gluetun `Dockerfile`, `internal/firewall/enable.go` |
| kustomize-controller main defaults `StrictPostBuildSubstitutions=true`: an undefined `${VAR}` without default becomes a build error after a Flux bump | kustomize-controller `internal/features/features.go` |

## Architecture

```
repo                         publish                          install (marketplace-ui)           cluster (flux-system)
────                         ───────                          ────────────────────────           ─────────────────────
components/<name>/      ──▶  oci://…/marketplace/        ──▶  user-apps/apps/<app>/          ──▶  OCIRepository app (pinned)
  component.yaml               components/<name>:<ver>          source.yaml   (unchanged)          OCIRepository app-<c> (pinned)
  kustomization.yaml           + :latest, cosign-signed         components.yaml (NEW, if any)      ArtifactGenerator app
  manifests                    (rolling tag)                    generator.yaml  (NEW, if any)        └▶ ExternalArtifact app
                                                                release.yaml  (patched if any)     Kustomization app
apps/<app>/metadata.yaml ──▶  catalog.yaml: components map                                           sourceRef ExternalArtifact
  spec.components (opt-in)     + per-app component list                                           path ./overlays/librepod
                                                                                                    components: ../../shared-components/<c>
```

Plain installs (no components) are byte-for-byte today's three files: no
generator, no dependency on source-watcher.

### 1. Repo layer — `components/<name>/`

```
components/tailscale/
├── component.yaml        # descriptor — read by catalog generation, ignored by kustomize
├── kustomization.yaml    # kind: Component; images: pin (renovate-managed)
├── patch-deployment.yaml
├── externalsecret.yaml
├── pvc.yaml
└── tailscale.env
```

Descriptor (`component.yaml`):

```yaml
apiVersion: marketplace/v1
kind: ComponentDefinition
metadata:
  name: tailscale
spec:
  displayName: "Tailscale"
  description: "Join this app to your tailnet with a tailscale sidecar"
  # renovate: datasource=docker depName=tailscale/tailscale
  version: "v1.104.2"        # native version = the image tag in kustomization.yaml images:
  group: network             # at most one component per group per app (UI radio)
  kind: patch                # patch | resource — patch needs the app's target annotation
  settings:                  # same item schema as app settings → OpenBao apps/<app>/<name>
    - name: TS_AUTHKEY
      label: "Tailnet auth key"
      type: string
      required: true
      sensitive: true
  values:                    # non-secret → Flux postBuild.substitute in release.yaml
    - name: FRP_EXPOSE_SUBDOMAIN   # (frp-expose example)
      from: install          # install = asked in the dialog; app = supplied by the app's metadata;
                             # derived = filled from the component's other values ({NAME} template in default)
      default: "{app}"       # "{app}" = the app name, filled by the renderer
      pattern: "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$"
```

Rules for component authors:

- **Patch targeting.** Patch components patch the Deployment carrying the
  annotation `librepod.org/component-target: "true"` via
  `patches[].target.annotationSelector`; the patch file's `metadata.name` is a
  placeholder. An app that lists a patch component annotates exactly one
  Deployment.
- **No namespaces.** Component resources omit `namespace:` and inherit the
  overlay's.
- **Fixed names.** Resource names are fixed per component (`tailscale-state`,
  `gluetun-settings`, …) — the app namespace isolates them.
- **Image pins** live in the component's own `kustomization.yaml images:`; the
  descriptor `version` equals that tag. Renovate bumps both together (one
  grouped update), exactly like app `metadata.yaml` version + overlay pin.
  Resource-only components with no image (frp-expose) carry a hand-bumped
  semver.
- **Substitution.** Every `${VAR}` in a component has a default
  (`${VAR:=default}`) so strict substitution never fails a build; values are
  simple scalars only (kustomize strips quotes, so Flux substitution yields
  bare scalars). `INSTANCE_NAME` is always provided by the renderer when components
  are present. Today it equals the app name; the variable name comes from the
  multi-instance proposal (#246) so components need no rename when instances
  land (my call).
- **Secrets.** A component that has `settings` ships its own ExternalSecret
  `<name>-settings` (ClusterSecretStore `openbao`, `dataFrom.extract.key:
  apps/${INSTANCE_NAME}/<name>`) producing Secret `<name>-settings`, consumed only by
  the component's own container (env or file mount). Never merged into
  `<app>-settings`.

App opt-in (`apps/<app>/metadata.yaml`):

```yaml
spec:
  components:
    - name: frp-expose
      values:                                   # every `from: app` value of the component
        FRP_EXPOSE_HOST: immich-server.immich.svc.cluster.local
        FRP_EXPOSE_PORT: "2283"
```

An app may also set a `from: install` value here. It then replaces the
component's default as the dialog prefill, and the user can still change it.
collie uses this to keep `TS_HOSTNAME: collie-lead` (my call).

### 2. Publish layer

- New `scripts/publish-components.sh` + `scripts/test-publish-components.sh`
  (repo CI rule: logic in scripts, workflow YAML only wires env and calls one
  line), invoked by new `.github/workflows/publish-components.yaml`.
- Trigger: push to `master` and PRs touching `components/**`. Detect changed
  component dirs (same approach as `publish-apps.yaml`).
- Master: `flux push artifact oci://ghcr.io/<owner>/marketplace/components/<name>:<version>`
  with `--path=./components/<name>`, then the same for `:latest`, each signed
  with the repo's cosign key exactly as `publish-apps.yaml` signs app
  artifacts. A manifest-only change re-pushes the same `<version>` tag (rolling
  tag) — installs pinned to it converge on the next 10m poll.
- PRs: `:pr-<n>` signed keyless, as apps do. Note: keyless PR artifacts fail the
  cluster's key-based `verify`, so PR component artifacts cannot be installed on
  a cluster through the UI — test them with a hand-written source without
  `verify`.
- App artifacts are **unchanged** — no vendoring, no slots, no wrapper.

App/component compatibility check (CI, in `validate-apps`): new
`scripts/check-app-components.sh` + test. For every app listing components and
for each listed component: copy the component into a temp tree at the
generator's layout (`shared-components/<name>/`), build `overlays/librepod` with
the component added, apply the app's `values` as substitution, and assert:

- patch component → exactly one Deployment carries the target annotation and
  gained the component's container;
- resource component → its resources are present;
- every `from: app` value is supplied by the app.

### 3. Catalog layer

`scripts/generate-catalog.sh` (+ `test-generate-catalog.sh` cases):

- Top-level `components:` map built from `components/*/component.yaml`:
  `name → {displayName, description, version, group, kind, settings, values}`.
- Per-app `components:` list from `metadata.yaml spec.components`:
  `[{name, values}]`. Generation fails on an unknown component name, a
  missing `from: app` value, or a value name the component does not declare.
- No new per-app templates. The component-source and generator shapes are
  platform-fixed and owned by the renderer (catalog.yaml is already ~73%
  template bodies).

The catalog's component `version` is the "latest" side of the future update
comparison; the installed side is recorded in the cluster (below).

### 4. Install layer — marketplace-ui

**API.** The existing install request body gains:

```json
{ "components": [ { "name": "tailscale", "settings": { "TS_AUTHKEY": "…" }, "values": {} } ] }
```

Server-side validation (400 on failure): each name is in the app's catalog
component list; at most one per `group`; required settings present; `from:
install` values present or defaulted and matching `pattern`; no unknown keys.

**Writes, in order** (same mutex and error handling as today's install):

1. App settings → OpenBao `apps/<app>` (unchanged).
2. Each selected component's settings → OpenBao `apps/<app>/<component>`.
3. One Gogs commit with the app's files.

**Files when no component is selected:** today's `source.yaml`, `release.yaml`,
`kustomization.yaml` (and legacy `secret.yaml`), unchanged.

**Files when ≥1 component is selected:**

- `source.yaml` — unchanged (app OCIRepository pinned to the app version).
- `components.yaml` — one OCIRepository per selected component:

  ```yaml
  apiVersion: source.toolkit.fluxcd.io/v1
  kind: OCIRepository
  metadata:
    name: marketplace-<app>-<component>
    namespace: flux-system
    labels:
      marketplace.io/managed: "true"
      marketplace.io/app: "<app>"
      marketplace.io/component: "<component>"
  spec:
    interval: 10m
    url: oci://ghcr.io/librepod/marketplace/components/<component>
    ref:
      tag: "<catalog component version at install time>"
    verify:
      provider: cosign
      secretRef:
        name: cosign-pub
  ```

  The pinned `ref.tag` **is** the recorded installed version (goal 4). The
  future update feature lists OCIRepositories labelled `marketplace.io/component`
  and compares `spec.ref.tag` with the catalog.

- `generator.yaml`:

  ```yaml
  apiVersion: source.extensions.fluxcd.io/v1beta1
  kind: ArtifactGenerator
  metadata:
    name: marketplace-<app>
    namespace: flux-system
    labels: {marketplace.io/managed: "true", marketplace.io/app: "<app>"}
  spec:
    sources:
      - alias: app
        kind: OCIRepository
        name: marketplace-<app>
      - alias: <component>              # one per selected component
        kind: OCIRepository
        name: marketplace-<app>-<component>
    artifacts:
      - name: marketplace-<app>
        originRevision: "@app"
        copy:
          - from: "@app/"
            to: "@artifact/"
          - from: "@<component>/"       # one per selected component
            to: "@artifact/shared-components/<component>/"
  ```

  `shared-components/` is deliberately not `components/`: apps already use
  `components/` for app-private kustomize components.

- `release.yaml` — rendered from the app's template as today, then modified
  with `js-yaml` (already a server dependency; per-app templates are not
  edited):
  - `spec.sourceRef` → `{kind: ExternalArtifact, name: marketplace-<app>}`
  - `spec.components` → `["../../shared-components/<component>", …]` (sorted by
    name for stable output)
  - `spec.postBuild.substitute` += `INSTANCE_NAME` + every selected component's
    values (app-supplied from the catalog, install-supplied from the request)
- `kustomization.yaml` — the app's template output with `components.yaml` and
  `generator.yaml` appended to `resources`.

**Status, uninstall.** Unchanged code paths. Status still reads the app
Kustomization by label; a generator or component-source failure shows as the
Kustomization not Ready. Uninstall removes the app directory; Flux prunes the
sources, generator (whose finalizer deletes the ExternalArtifact) and the app.
OpenBao entries stay, as app settings do today.

**UI.** `InstallDialog` gains a "Components" section, shown only when the app
lists components:

- components with a `group` render as a radio (None + members); ungrouped ones
  as checkboxes;
- selecting one reveals its `settings` and `from: install` values, reusing the
  existing settings field rendering; install values are prefilled with their
  default;
- a new setting type `text` (multi-line, rendered as a textarea) is added to
  `AppSettingType` for pasted configs (WireGuard, sing-box JSON). Sensitive
  `text` values are handled like sensitive strings.

### 5. Platform layer — source-watcher

- Dev: done (FluxInstance `spec.components` includes `source-watcher`).
- `clusters/librepod-k3d/bootstrap/flux-instance.yaml`: today it sets no
  `instance.components` (chart defaults). Add `instance.components` listing
  `source-controller`, `kustomize-controller`, `helm-controller`,
  `notification-controller`, `source-watcher`.
- Production: add `source-watcher` to its FluxInstance `spec.components` before
  any component install there.

## The v1 components

### `gluetun` — group `network`, kind `patch`

- Native sidecar (an `initContainers` entry with `restartPolicy: Always`) on
  the annotated Deployment: the app container starts only after gluetun's
  startup probe passes.
- `startupProbe`: `exec: ["/gluetun-entrypoint", "healthcheck"]` (the image's
  own HEALTHCHECK). Not `httpGet` — the health server is loopback-only.
- `NET_ADMIN`; `/dev/net/tun` via `hostPath` `CharDevice`.
- `VPN_SERVICE_PROVIDER=custom`, `VPN_TYPE=wireguard`; the WireGuard config
  comes from setting `WG_CONFIG` (`text`, sensitive, required) in Secret
  `gluetun-settings`, mounted as a file at the path gluetun's custom provider
  reads (builder: confirm the current path in gluetun's docs).
- `FIREWALL_OUTBOUND_SUBNETS: "10.42.0.0/16,10.43.0.0/16"` (k3s default pod and
  service CIDRs, hard-coded with a comment). Without it, cluster-local traffic
  (other Services, CoreDNS) is dropped.
- Known limitations (help text): LAN / device-IP destinations go into the
  tunnel; DNS stays on CoreDNS, so external lookups resolve via the node
  (potential DNS leak).

### `sing-box` — group `network`, kind `patch`

- Native sidecar; `NET_ADMIN` + `/dev/net/tun`.
- Setting `CONFIG` (`text`, sensitive, required) — full sing-box JSON, mounted at
  `/etc/sing-box/config.json`; command `sing-box run -c /etc/sing-box/config.json`.
- No startup gate (the config is opaque). Routing rules, including direct
  routes for the cluster CIDRs, are the user's responsibility (help text says
  so).

### `tailscale` — group `network`, kind `patch` (extracted from collie + remnawave)

Based on collie's version (the one validated in production, including the
re-enrolment fix):

- Regular sidecar container `tailscale` (containerboot), `runAsUser: 0`,
  `NET_ADMIN`, `/dev/net/tun` `hostPath`.
- Env (ConfigMap from `tailscale.env`): `TS_USERSPACE=false`,
  `TS_ACCEPT_DNS=false`, `TS_STATE_DIR=/var/lib/tailscale`, `TS_KUBE_SECRET=""`
  (no Kubernetes API use, so no RBAC and no ServiceAccount change),
  `TS_AUTH_ONCE=true` (no re-enrolment on restart), `TS_ENABLE_HEALTH_CHECK=true`,
  `TS_NO_LOGS_NO_SUPPORT=true`, `TS_HOSTNAME=${TS_HOSTNAME:=app}` (the renderer
  always supplies the value).
- Settings (`tailscale-settings` Secret): `TS_AUTHKEY` (sensitive, required),
  `TS_EXTRA_ARGS` (optional, e.g. `--login-server=https://…` for headscale).
- Value `TS_HOSTNAME` (`from: install`, default `{app}`, DNS-label pattern) sets
  the node name. It is a value rather than a setting so an app can supply its
  own default (my call).
- State: PVC `tailscale-state` (component resource) mounted at
  `/var/lib/tailscale`.
- `startupProbe`: `httpGet /healthz` on port 9002.
- DNS: collie's MagicDNS-first `dnsPolicy: None` + `dnsConfig` (nameservers
  `100.100.100.100`, `10.43.0.10`; `timeout: 1`, `attempts: 2`) so the app
  resolves tailnet names and degrades to CoreDNS within ~1s if the sidecar is
  down.
  - Search domains: `ts.${BASE_DOMAIN:=libre.pod}`,
    `${INSTANCE_NAME}.svc.cluster.local`, `svc.cluster.local`, `cluster.local`.
  - The cluster entries are needed because `dnsPolicy: None` drops the pod's
    cluster search list, and apps reach their own Services by short name
    (remnawave → `remnawave-postgres`).
  - This assumes the namespace equals `INSTANCE_NAME`, which holds for every
    app today. Collie's copy lacks these entries; this fix came from review
    (my call).
- In-cluster names resolve through 100.100.100.100 only because the bundled
  headscale routes `cluster.local` to CoreDNS through split DNS.
  - On a tailnet that overrides local DNS without such a route, cluster lookups
    get NXDOMAIN from the global resolvers and do not fall back.
  - Help text says so. The dev e2e checks remnawave → postgres with the sidecar
    up.
- Image: `tailscale/tailscale` `v1.104.2` (the newer of the two app pins).
- Does **not** set `serviceAccountName`.

### `frp-expose` — group `exposure`, kind `resource` (extracted from headscale)

```yaml
apiVersion: frp.zufardhiyaulhaq.com/v1alpha1
kind: Upstream
metadata:
  # Registered with frps as the proxy name; must be unique per relay.
  name: ${FRP_EXPOSE_SUBDOMAIN:=app}
spec:
  client: libreport
  http:
    host: ${FRP_EXPOSE_HOST:=localhost}
    port: ${FRP_EXPOSE_PORT:=80}
    subdomain: ${FRP_EXPOSE_SUBDOMAIN:=app}
    healthCheck:
      type: tcp
      timeoutSeconds: 3
      intervalSeconds: 10
      maxFailed: 3
    transport:
      useEncryption: true
      useCompression: true
```

- Values: `FRP_EXPOSE_HOST` and `FRP_EXPOSE_PORT` (`from: app`, the in-cluster
  Service FQDN and port); `FRP_EXPOSE_SUBDOMAIN` (`from: install`, default the
  app name, DNS-label pattern). Subdomain = proxy name, so two devices sharing a
  relay must pick different subdomains; a collision shows up as the Upstream /
  frpc reporting the name taken.
- `FRP_EXPOSE_DOMAIN` (`from: install`, DNS-name pattern, no default) is the
  relay's base domain. Nothing on the device knows it, so the dialog asks.
- **Exposure contract.** Group `exposure` components must provide `PUBLIC_HOST`
  (enforced by `check-app-components.sh`); frp-expose derives it as
  `{FRP_EXPOSE_SUBDOMAIN}.{FRP_EXPOSE_DOMAIN}` (`from: derived`). Apps read
  only `${PUBLIC_HOST:=<local fallback>}`, so a later cloudflared or ngrok
  component needs no app change.
- Public address: `https://${PUBLIC_HOST}`; TLS is terminated at the
  relay, which forwards plain HTTP to frps' vhost port (headscale's setup).
- The health check is `tcp` (generic) rather than headscale's `http /health`.
- Version: `1.0.0`, hand-bumped.
- Known limit: SSO (Casdoor) login does not work through the relay (Casdoor is
  only on the local domain); apps with their own login work. Apps whose only
  login is Traefik forward-auth are exposed without a login — user's choice.

## Migration (big-bang, downtime accepted)

| App | Change | Existing install |
|---|---|---|
| collie | Delete `components/tailscale`, its overlay `components:` entry and `images:` pin; drop `TS_*` from `settings`; move `serviceAccountName: default` (its own legacy-SA workaround) into `base/`; annotate the Deployment; `spec.components: [{name: tailscale, values: {TS_HOSTNAME: collie-lead}}]` (keeps the documented `collie-lead.ts.<domain>` address) | Reinstall with tailscale selected. The new state PVC means the node enrols again and needs a fresh auth key. Delete the old `collie-lead` node first, or the control server gives the new one a suffixed name and `COLLIE_PUBLIC_URL` breaks |
| remnawave | Delete `components/tailscale` (incl. its SA/Role/RoleBinding/PVC) and the commented overlay reference; annotate the Deployment; `spec.components: [{name: tailscale}]` | Reinstall if tailscale is wanted. An install whose `release.yaml` was hand-edited to add `../../components/tailscale` stops building once the re-pushed artifact drops that directory, and needs a reinstall |
| headscale | Delete `components/frp-upstreams` and its overlay entry; `spec.components: [{name: frp-expose, values: {FRP_EXPOSE_HOST: headscale.headscale.svc.cluster.local, FRP_EXPOSE_PORT: "80"}}]`; `server_url` (`base/config.yaml`), headplane `public_url` and the SSOClient redirect URI become `https://${PUBLIC_HOST:=headscale.${BASE_DOMAIN:=libre.pod}}`; drop `FRP_DOMAIN` and every FRP mention from the app | Reinstall with frp-expose selected, subdomain `headscale` and the relay domain. Without an exposure component, headscale falls back to its local host, so only devices that reach the device (home network or VPN) can join |
| firefly-iii-telegram-bot | Annotate the Deployment; `spec.components: [{name: gluetun}, {name: sing-box}]` | n/a (new capability) |
| immich | `spec.components: [{name: frp-expose, values: {FRP_EXPOSE_HOST: immich-server.immich.svc.cluster.local, FRP_EXPOSE_PORT: "2283"}}]` | n/a |

These five are the v1 opt-ins (my call); other apps opt in later by adding the
annotation and a `spec.components` entry. App-artifact changes from the table
ship as rolling re-pushes of the current app tags (no version bump needed for a
big-bang migration).

## Failure modes

| Risk | Handling |
|---|---|
| A cluster without the source-watcher CRDs gets a components install | `generator.yaml` fails the apply of the shared `user-apps` Kustomization. Every user-app change on the device stalls until that app is removed. Rollout order prevents this, not code: the FluxInstance change lands on a cluster before any marketplace-ui release that renders components. Only maintainer devices exist (my call) |
| source-watcher is v1beta1 and fast-moving | Once its CRDs exist, only installs with components depend on it. A generator that is not Ready stalls only that one app, which retries; no data is lost |
| Component source tag missing / verify fails | ArtifactGenerator not Ready → app Kustomization not Ready → app shows Error; reinstall without the component |
| Patch target missing (app renamed its Deployment or dropped the annotation) | `check-app-components.sh` fails the app's PR in CI |
| Broken WG / sing-box config or bad tailscale auth key | Sidecar crash-loops or never passes its startup probe; the app shows Error. Human-supplied credential → reinstall with a fixed value |
| Two network components on one pod | Prevented: one `network` group, validated server-side |
| `/dev/net/tun` unavailable (Kata runtime, hardened nodes) | Flagged for the dev e2e; fallback (privileged mknod init container) only if a real node needs it |
| Subdomain collision on a shared relay | Visible in Upstream/frpc status; reinstall with another subdomain |
| Flux bump turns on strict substitution | Component `${VAR}`s all carry defaults (author rule) |

## Testing

1. `scripts/test-publish-components.sh` — change detection, tag selection
   (version vs `pr-<n>`), dry-run push commands.
2. `scripts/test-check-app-components.sh` — fixture app + fixture patch and
   resource components: annotated target gains the container; un-annotated
   sibling untouched; missing annotation fails; missing app value fails.
3. `scripts/test-generate-catalog.sh` — components map and per-app lists;
   unknown component and missing value fail.
4. Server unit tests — golden files for 0, 1 and 2 selected components
   (`components.yaml`, `generator.yaml`, patched `release.yaml` and
   `kustomization.yaml`); validation errors (unknown, two in a group, missing
   required, bad pattern); OpenBao writes per component; no component secret
   lands in `apps/<app>`.
5. Client tests — Components section renders radio/checkboxes, reveals fields
   on selection, `text` type renders a textarea; payload shape.
6. E2E on dev (verify-app flow / UI): hand-written generator smoke first; then
   firefly-iii-telegram-bot + gluetun against a real WireGuard endpoint
   (outbound IP changes, Firefly still reachable), collie + tailscale (joins
   headscale, MagicDNS resolves), headscale + frp-expose (reachable at
   `https://headscale.<relay domain>`), immich + frp-expose.

## Rollout order

1. Dev smoke test: one hand-written ArtifactGenerator composing an installed
   app with a hand-pushed component artifact; confirm the Kustomization builds
   with `spec.components`.
2. `components/` (gluetun, sing-box, tailscale, frp-expose) + publish scripts
   and workflow + `check-app-components.sh` in validate-apps.
3. Catalog generation.
4. marketplace-ui: API validation, renderer, OpenBao writes, dialog, `text`
   setting type.
5. App migrations (table above), k3d bootstrap FluxInstance, dev e2e, then
   production FluxInstance and reinstalls of collie / headscale.

Plan boundary (my call): the plan's agent tasks are the repo work, CI and local
tests, meaning steps 2–4 and the repo half of step 5. Anything that needs a
person or a live cluster goes on a handoff checklist, done by the maintainer or
with their go-ahead:

- The dev smoke test (step 1) is a checkpoint before step 4 merges, not a
  blocker for steps 2–3.
- E2E needs credentials: a WireGuard config, a sing-box config, a headscale
  pre-auth key and a free relay subdomain.
- After the first component publish, confirm the `marketplace/components/*`
  GHCR packages are public. New packages may start private, and a private one
  fails every install pull.
- Production must be ready **before** the marketplace-ui release that renders
  components:
  - confirm its Flux is new enough for source-watcher (2.7.2 or later);
  - add `source-watcher` to its FluxInstance, which lives outside this repo.
- Release marketplace-ui and bump its system-app pin.
- Reinstall collie and headscale, and remnawave if wanted.

## Left to the builder

- gluetun's current custom-WireGuard config file path and env names.
- Exact ExternalSecret `key` form for nested OpenBao paths (confirm the store
  resolves `apps/<app>/<component>` like `apps/<app>`).
- Renovate config grouping for a component's descriptor version + `images:` pin.
- Field-level UI copy and layout inside the Components section.

## Naming

User- and repo-facing term: **component** (`components/`, `spec.components`,
catalog `components:`, UI "Components"). Say **kustomize component** for
`kind: Component`. In the generated artifact, shared components live under
`shared-components/` to stay apart from app-private `components/`.
