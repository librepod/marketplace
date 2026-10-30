# Shared App Components — Design

**Date:** 2026-10-30
**Status:** Proposed (awaiting review)
**Branch:** `feat/shared-app-components`

## Problem

Marketplace apps are immutable, version-pinned OCI artifacts — every installer of an
app gets a byte-identical deployment. Two recurring needs don't fit that model:

1. **Outbound egress through a VPN/proxy.** Apps that talk to services blocked at
   the user's location (e.g. `firefly-iii-telegram-bot` → Telegram API from Russia)
   need their pod's traffic routed through a tunnel the *user* brings.
2. **Exposing an app outside the cluster via FRP.** frp-operator is platform
   infrastructure; a user should be able to attach an `Upstream` CR to an installed
   app (e.g. immich through a relay) without hand-editing manifests.

Today's per-install variance channels are only `postBuild.substitute`
(BASE_DOMAIN, DEVICE_IP) and the settings→OpenBao→ESO path. There is no way for a
user to choose, per install, that an app ships with an extra sidecar or an extra
cluster resource.

## Solution in one paragraph

A shared component library lives at repo-root `./components/` (single place,
kustomize `kind: Component` + a descriptor). At publish time each app's OCI
artifact is assembled to also contain **stamped copies of the components the app
declares** plus an `install/` wrapper and four inert "slot" components. At install
time the marketplace renderer emits a Flux **ArtifactGenerator** (from
`fluxcd/source-watcher`) whose copy operations drop the *selected* components into
the slots — per-install composition happens in-cluster, so the artifact ships
parts and the installation chooses the assembly. The app's Flux Kustomization
switches its `sourceRef` from the `OCIRepository` to the generated
`ExternalArtifact` and builds `./install`.

## Non-goals (v1)

- **Egress components on Helm-type apps.** Pod-patching a chart's rendered output
  is chart-internal and fragile; egress components attach to Kustomize-type apps
  only (the descriptor declares this). Revisit only when a Helm app actually needs it.
- **HTTPS-subdomain FRP exposure** (frp-operator `spec.https` lacks subdomain
  control — known upstream gap). v1 exposes raw TCP/UDP ports only.
- **Commercial-VPN provider flows for gluetun** (per-provider env var matrices).
  v1 accepts a full custom WireGuard config paste, which covers self-hosted
  wg-easy and any provider that exports WG confs.
- **Third-party component marketplace.** Components are repo-curated.
- **A component version visible to users.** Component updates ride the app
  artifact (see Update policy).

## Architecture

Four layers, each independently testable:

```
repo components/          publish assembly             install rendering              cluster
────────────────          ────────────────             ─────────────────              ───────
components/<name>/   ──▶  <app OCI artifact>     ──▶   user-apps repo files     ──▶   ArtifactGenerator
  Component (kustomize)     components/<name>/          source.yaml                    → ExternalArtifact
  component.yaml (desc)     components/_c1../_c4        generator.yaml   (selection)     → Kustomization
  __APP_NAME__ sentinels    install/kustomization       release.yaml                   (path ./install)
                            .yaml (wrapper)             (substitute additions)
```

### 1. Repo layer — `./components/`

One directory per component:

```
components/gluetun/
├── component.yaml          # descriptor (below)
├── kustomization.yaml      # kind: Component; images: pins the sidecar image (renovate-managed)
└── deployment-patch.yaml   # strategic-merge patch: native sidecar + startupProbe gate
```

Descriptor schema (`component.yaml`):

```yaml
kind: ComponentDescriptor
metadata:
  name: gluetun
spec:
  displayName: "VPN egress (gluetun)"
  description: "Route all pod traffic through a WireGuard tunnel"
  group: egress              # components in one group are mutually exclusive in the UI (radio)
  appliesTo:
    appTypes: [kustomize]    # kustomize | any; egress is pod-patching → kustomize-only in v1
  params:                    # app-declared, stamped at publish (see §2)
    - name: deploymentName   # example; defaults to __APP_NAME__ when absent
      required: false
  settings:                  # SAME item schema as app settings (label/description/type/
    - name: GLUETUN_WG_CONFIG    # required/sensitive) — delivered via OpenBao → <app>-settings
      sensitive: true           # Secret → envFrom / secret volume in the sidecar
      required: true
  substitute:                # per-install NON-secret values → postBuild.substitute in release.yaml
    - name: FRP_REMOTE_PORT  # (frp-expose example) — item shape mirrors settings
      default: "0"
```

Rules:

- Component manifests may use sentinels `__APP_NAME__` and `__PARAM_<NAME>__`;
  both are stamped by the assembler.
- Component resources hardcode their own namespace/labels — kustomize component
  transformers merge into the overlay ROOT, so relying on inheritance is a trap
  (established gotcha). The overlay's `images:` transformer does NOT reach into a
  component's own `images:` pins — each component pins its sidecar image itself,
  with a `# renovate:` annotation, managed in exactly one place (`./components/`).
- Settings keys are component-prefixed (`GLUETUN_*`, `SINGBOX_*`, `FRP_*`) and
  merged into the app's single OpenBao entry (`apps/<app>`), delivered by the
  app's existing ExternalSecret — no new Secret, no new ESO object.

### 2. Publish layer — artifact assembly

New script `scripts/assemble-app.sh <app>` (consumed by the publish workflow,
verify-app, and local builds; tested by `scripts/test-assemble-app.sh`):

1. Copy `apps/<app>/` to the artifact staging tree.
2. For each entry in `metadata.yaml spec.components`: copy `./components/<name>/`
   into `<artifact>/components/<name>/`, stamping `__APP_NAME__` and
   `__PARAM_<NAME>__` (values from the app's `params:` map). Validate declared
   params against the descriptor (unknown → error; required missing → error).
3. Generate four noop slot components `components/_c1../_c4/kustomization.yaml`
   (minimal `kind: Component`, no resources).
4. Generate the wrapper `install/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../overlays/librepod
components:
  - ../components/_c1
  - ../components/_c2
  - ../components/_c3
  - ../components/_c4
```

The published artifact is signed/pushed exactly as today (same tags: `spec.version`
and `latest`). Apps that declare no components still get slots + wrapper (uniform
artifact shape).

**Renderer emission rule:** every NEW install renders all four files (generator
with zero component copies = a plain passthrough composite) — one runtime shape,
no branching. Installations made before this feature keep their old three-file
shape (sourceRef OCIRepository, `path: ./overlays/librepod`) untouched; they are
migrated to the four-file shape the first time the user performs an action that
re-renders their manifests (attaching/detaching a component). A republish alone
never rewrites an installed app's manifests.

App opt-in in `metadata.yaml`:

```yaml
spec:
  components:
    - name: gluetun                 # no params needed; deployment target = app name
    - name: frp-expose
      params:
        localPort: 8083             # the app's Service port to tunnel
        protocol: tcp
```

### 3. Install layer — renderer output

marketplace-ui renders four files per app into the user-apps Gogs repo (templates
live in `metadata.yaml templates:` and flow through catalog.yaml like the existing
three):

- `source.yaml` — unchanged (`OCIRepository marketplace-<app>`, cosign-verified,
  tag `__VERSION__`).
- `generator.yaml` — NEW template, `ArtifactGenerator`:

```yaml
apiVersion: source.extensions.fluxcd.io/v1beta1
kind: ArtifactGenerator
metadata:
  name: marketplace-<app>
  namespace: flux-system
  labels: {marketplace.io/managed: "true", marketplace.io/app: "<app>"}
spec:
  interval: 10m
  sources:
    - alias: app
      kind: OCIRepository
      name: marketplace-<app>
  artifacts:
    - name: marketplace-<app>
      copy:
        - from: "@app/"
          to: "@artifact/"
        __COMPONENT_COPIES__
```

- `release.yaml` — `sourceRef` becomes `{kind: ExternalArtifact,
  name: marketplace-<app>}`, `path: ./install`, and `postBuild.substitute`
  carries `__COMPONENT_SUBSTITUTE__` below `BASE_DOMAIN`.
- root `kustomization.yaml` — now lists source, generator, release.

Sentinels are filled by the renderer from the selection:

- `__COMPONENT_COPIES__` → one stanza per selected component, **slots assigned in
  the stable (alphabetical) order of component names** so re-renders are
  idempotent and attach/detach never reshuffles:

```yaml
        - from: "@app/components/frp-expose/**"
          to: "@artifact/components/_c1/"
        - from: "@app/components/gluetun/**"
          to: "@artifact/components/_c2/"
```

- `__COMPONENT_SUBSTITUTE__` → `KEY: "value"` lines for every `substitute` item
  of every selected component (resolved question answer → default → renderer-
  generated default frozen at first render, see frp-expose).

The renderer stays a dumb template-filler — no YAML parsing, no authored patches.
`dependsOn`, `force: true`, `prune: true`, `wait: true` carry over unchanged.

### 4. Platform layer — source-watcher

`source-watcher` (the controller implementing ArtifactGenerator) is a first-class
flux-operator component — the installed `fluxinstances` CRD enum includes it.
Rollout = add to `spec.components` in each cluster's FluxInstance:

- `clusters/librepod-k3d/bootstrap/flux-instance.yaml` (bootstrap path)
- dev + production FluxInstances

Requires Flux ≥ 2.7.2; dev already runs controller v1.9.6 with the
`externalartifacts` CRD present and `ExternalArtifact` accepted as a Kustomization
`sourceRef` (verified on the live cluster). Trust chain: the OCIRepository remains
the cosign-verified root; the ExternalArtifact is derived by source-watcher from
source-controller's verified artifact storage.

## The v1 components

### egress: `gluetun`

Strategic-merge patch (stamped `__APP_NAME__`) adding to the app Deployment:

- **Native sidecar** (initContainers entry, `restartPolicy: Always`) — starts
  before the app container and stays running.
- `qdm12/gluetun` image, tag pinned in the component's own `images:` + renovate.
- `securityContext.capabilities: [NET_ADMIN]`; `/dev/net/tun` via hostPath
  charDevice (fallback: privileged mknod init container — decide in e2e; Kata
  runtime interaction is a flagged risk).
- `VPN_SERVICE_PROVIDER=custom` + the user's WireGuard config: setting
  `GLUETUN_WG_CONFIG` (sensitive, required) mounted as a file via the
  `<app>-settings` Secret (subPath → `/gluetun/wg-custom.conf`).
- `FIREWALL_OUTBOUND_SUBNETS: "10.42.0.0/16,10.43.0.0/16"` — **the correctness
  critical bit**: without it the tunnel swallows cluster-local traffic (firefly
  bot → firefly-iii Service, CoreDNS) and the app breaks while "on VPN".
  Platform-standard k3s CIDRs, hardcoded in the component with an inline comment.
- `startupProbe` on gluetun's control-server health endpoint → the app container
  cannot start until the tunnel is up (native sidecar semantics), replacing any
  hand-rolled gate container.

Known limitation (accepted): cluster DNS stays on CoreDNS; external lookups
resolve via the node (potential DNS leak). Fine for IP-blocked services; deeper
censorship resistance is a follow-up.

### egress: `sing-box`

Same patch shape. Setting `SINGBOX_CONFIG` (sensitive, required — full JSON
config paste) mounted to `/etc/sing-box/config.json`; container runs
`sing-box run -c /etc/sing-box/config.json`. Tun-mode config is user-supplied, so
routing rules (including cluster-CIDR direct rules) are the user's responsibility
— the dialog help text says so. No startup gate (config is opaque); the app's own
retries cover the gap (self-heal posture).

### expose: `frp-expose`

Resource-only component (works for **any** app type — nothing patches the pod):

```yaml
apiVersion: frp.zufardhiyaulhaq.com/v1alpha1
kind: Upstream
metadata:
  # Proxy name must be unique per relay across all devices sharing it — defaults
  # to the app name for single-device relays, renderer appends a random suffix
  # (frozen at first render) when the user doesn't choose one.
  name: ${FRP_PROXY_NAME:-__APP_NAME__}
spec:
  client: ${FRP_CLIENT:-libreport}
  __PARAM_PROTOCOL__:
    host: __APP_NAME__.__APP_NAME__.svc.cluster.local
    port: __PARAM_LOCAL_PORT__
    server:
      port: ${FRP_REMOTE_PORT:-0}   # 0 = relay auto-assign
```

- App params (publish-stamped): `localPort` (required), `protocol` (`tcp`|`udp`).
- Per-install substitute: `FRP_REMOTE_PORT` (default 0 = auto-assign);
  `FRP_PROXY_NAME` — renderer-generated default `<app>-<6-char-random>`, frozen
  into release.yaml at first render (proxy names must be unique per relay; never
  re-randomize on re-render); `FRP_CLIENT` default `libreport`, not surfaced in
  the dialog v1.
- frp-operator watches Upstreams cluster-wide; the CR lives in the app namespace.

## Post-install attach/detach

The app's Manage page shows the same component section as the install dialog.
Saving re-renders `generator.yaml` (± one copy stanza) and `release.yaml`
(± substitute lines) and commits — the existing Gogs commit path. Consequences:

- Attaching frp-expose never restarts the app pod (rendered Deployment unchanged).
- Attaching gluetun rolls the pod once (spec genuinely changed).
- Detaching prunes the Upstream CR / sidecar via normal Flux pruning.
- Switching egress component (gluetun ↔ sing-box) = swap one copy stanza.

Uninstall of the app removes all four files; pruning cascades (Kustomization →
app resources; generator → ExternalArtifacts via ownership).

## Catalog & UI

- `generate-catalog.sh` merges each app's `spec.components` with the descriptors
  from `./components/*/component.yaml` and emits a resolved `components:` block
  per app entry (displayName, description, group, settings, substitute,
  params-consumed). The UI reads only catalog.yaml, as today.
- Install dialog: a "Components" section — `group: egress` renders as a radio
  (none / gluetun / sing-box), ungrouped components as checkboxes; selecting one
  reveals its `settings` + `substitute` fields inline.
- Settings storage: component settings items are resolved and stored into the
  app's existing OpenBao entry (prefixed keys), never a separate entry; the
  install stays one-click if nothing is selected and no required items fire.
- API: `POST /installed-apps/:name/components` with the selection + answers;
  idempotent; server-side validation that each selected component is in the
  app's catalog list and group constraints hold.

## Update policy (deliberate decision)

Component content changes republish every supporting app's artifact under the
**same** `spec.version` tag (mutable tag) plus `latest`. Installed clusters pick
the new digest up via the OCIRepository's 10m poll and converge silently —
component fixes roll to existing installs without user action. This is aligned
with the "self-heal, never nag" product philosophy, and is chosen over
component-visible versioning (YAGNI). App `spec.version` bumps remain the only
user-visible version signal. The spec accepts the consequence: `ref.tag` no
longer implies byte-frozen content for component-bearing apps.

## Failure modes & guardrails

| Risk | Guardrail |
|---|---|
| source-watcher is v1beta1/young | Official fluxcd project w/ e2e; failure is a stalled install (retries), never data loss; contained to clusters that opted into components |
| Slot overwrite leaves stale files | Noop slots are a single `kustomization.yaml`, overwritten by the selected component's own `kustomization.yaml`; e2e asserts the composite contains the sidecar |
| Component patch dangles (app Deployment renamed) | `assemble` test renders `./install` with each supported component dropped into `_c1` and asserts the patch target exists in output — publish-time failure, not a user's |
| Renderer re-randomizes defaults (frp proxy name) | Renderer reads current release.yaml from Gogs before rewriting; defaults frozen at first render; golden-file unit tests |
| `/dev/net/tun` unavailable (Kata, hardened nodes) | Flagged e2e risk on representative node runtimes; fallback mknod init container documented |
| User pastes broken WG/sing-box config | Sidecar CrashLoops, Flux retries; UI surfaces pod health on the Manage page (existing signals) — matches platform error philosophy (human-supplied credential = legitimate human loop) |
| Existing installs churn | Renderer only rewrites manifests when the user acts; republish alone never touches an installed app's manifests |

## Testing

1. `scripts/test-assemble-app.sh` — fixture app + fixture components: asserts
   vendoring, sentinel stamping, param validation errors, slot/wrapper generation,
   and `kustomize build` of (a) noop composite, (b) each component in `_c1`,
   asserting the expected resource/container appears in output.
2. Renderer unit tests (golden files): generator.yaml per selection shape; stable
   slot ordering; substitute line generation; frozen defaults on re-render.
3. Catalog test: components block merges descriptor fields correctly.
4. E2E on dev (`verify-app` flow): firefly-iii-telegram-bot + gluetun (real WG
   conf against a test tunnel), immich + frp-expose (Upstream registered, relay
   port reachable), attach/detach cycles on both.

## Rollout order

1. FluxInstance `+source-watcher` on dev; smoke-test one hand-written generator.
2. `assemble-app.sh` + tests; publish workflow integration; catalog changes.
3. `components/gluetun`, `components/sing-box`, `components/frp-expose` +
   opt-ins (firefly-iii-telegram-bot: gluetun+sing-box; immich: frp-expose).
4. UI: dialog section, renderer sentinels, Manage attach/detach API.
5. E2E on dev; FluxInstance rollout to production clusters.

## Naming

User-facing and repo-facing term is **component** (`./components/`,
`spec.components`, catalog `components:`, UI "Components"). Docs and code must
say **kustomize component** when referring to `kind: Component` to avoid the
collision.
