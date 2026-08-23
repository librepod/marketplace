# Platform / System-Apps UI — Design

**Date:** 2026-08-05
**Status:** Approved (design), pending implementation plan
**Scope:** `ui/` (marketplace installer UI/API), plus one verification step against a live cluster

> **⚠ Partly superseded (2026-08-22, issue #182) — historical design record.** The
> installed-detection layer described below is gone: `GogsService` and its
> `GOGS_URL`/`GOGS_USERNAME`/`GOGS_TOKEN` env triple were replaced by
> `UserAppsRepoService` over plain git, and there is no root `kustomization.yaml` — an app
> is installed iff `apps/<name>/` exists in the repo tree. The system-app concept, the
> label-vs-presence root cause, and the UI design still hold. For current behaviour see
> `ui/CLAUDE.md` — "No database — Git is the source of truth" and "App-store repo
> (`UserAppsRepoService`)" — plus `docs/DECISIONS_LOG.md` rows 7 and 8.

---

## 1. Background & root cause

The trigger was a user report: the **frp-operator** app on the control-plane UI
showed a permanent yellow **"Installing"** badge, even though the operator was
`1/1 Running` and its Flux Kustomization was `Ready=True / Healthy=True`.

Investigation traced this to a **definition mismatch**: the UI assumes a single
notion of "installed" that is actually two independent checks which only agree
for normal marketplace installs.

- **"Is it installed?"** — `GogsService.getInstalledAppNames()` reads the root
  `kustomization.yaml` of the on-cluster Gogs `flux/user-apps` repo and treats
  any `apps/<name>` entry as an installed app, purely by directory presence.
  **⚠ Superseded (#182):** now `UserAppsRepoService.listInstalledApps()` lists
  `apps/*` directory names from a shallow git working copy — same
  presence-based meaning, no root file and no REST API.
- **"What's its status?"** — `FluxStatusService.getStatusFor()` derives status
  only from Flux objects carrying the `marketplace.io/app=<name>` label (the
  signature of objects the marketplace installer creates).

For frp-operator these diverge: it is a **system app** deployed by the shared
`system-apps` Flux Kustomization, so its Kustomization carries only Flux
auto-labels — not `marketplace.io/app`. A separate per-device `apps/frp-operator`
entry in the Gogs user-apps repo (holding `Client` CR config for the relays,
*not* a marketplace install) makes the directory-presence check report it
"installed", while the label-based status probe finds nothing and falls back to
`return 'installing'` forever.

A wider look showed this is one instance of a general gap: **the UI has no
first-class concept of "system/managed app".** The only thing keeping platform
apps out of the Catalog is `CatalogService`'s filter `category !==
'Infrastructure'`, which is leaky because `category` is a *functional* taxonomy
(Network, Security, Development…), not a managed/unmanaged flag. Six platform
services currently leak through into the user catalog as seemingly-installable
apps: `frp-operator`, `gogs`, `casdoor`, `casdoor-sso-controller`,
`oauth2-proxy`, `marketplace-ui`. (A seventh candidate, `frpc`, is *commented
out* of `system-apps` and is intentionally a user app — so it correctly stays in
the Catalog. This is exactly the dynamic behaviour the redesign preserves.)

## 2. Goal & non-goals

**Goal.** Introduce a runtime-derived, per-cluster notion of "system-managed
app" and use it to (a) keep system apps out of the Catalog, (b) show them
read-only with live health in a dedicated **Platform** panel on the control-plane
page, (c) fix the forever-"Installing" badge by deriving status for system apps
from their system Flux object, and (d) hard-reject install/uninstall of managed
apps at the API.

**Non-goals.** No changes to `apps/*/metadata.yaml` (they stay generic). No
per-flavour catalog files. No changes to Flux/GitOps themselves. No "Open"
links for system apps in this iteration. Multi-cluster aggregation is out of
scope.

## 3. Concept: system-managed vs user apps

An app's "system-managed" status is **derived at runtime from the cluster**, not
stored. It is flavour-correct by construction: a LibrePod Enterprise or
public-cloud flavour has its own `system-apps` Kustomization reconciling its own
set, and the UI on that cluster reflects *that* set.

The source of truth is **membership in whatever the cluster's `system-apps`
Kustomization actually reconciles**. The set automatically tracks swaps: comment
an app out of `system-apps` and it stops being managed; uncomment/add one and it
becomes managed — no strings to maintain anywhere.

## 4. Detection mechanism

Flux's kustomize controller labels every resource it applies with
`kustomize.toolkit.fluxcd.io/name=<parent-ks>`. Everything the `system-apps`
Kustomization renders — including each app's `OCIRepository` — therefore carries
`kustomize.toolkit.fluxcd.io/name=system-apps`.

Each system app's `OCIRepository.spec.url` is uniformly
`oci://ghcr.io/librepod/marketplace/apps/<catalog-app-name>` (the LibrePod
packaging convention). The Flux object name is arbitrary (e.g. the nfs app's
OCIRepository/Kustomization is named `storage`); **the OCI URL's last path
segment is the canonical catalog identity** (`nfs-provisioner`).

Detection algorithm:

1. List `ocirepositories` in `flux-system` with label
   `kustomize.toolkit.fluxcd.io/name=system-apps`.
2. For each, parse `spec.url` → segment after `/apps/` → catalog app name.
3. Build `Map<catalogName, fluxObjectName>` (the object name is the paired
   Kustomization name, needed later for status).

> **Verification item (implementation step 1):** confirm on a live cluster that
> OCIRepositories (not just Kustomizations) carry the `system-apps` parent label.
> Flux documents this label injection for all applied resources, and it was
> observed on the frp-operator Kustomization, but it has not yet been confirmed
> specifically on OCIRepositories. If for any reason OCIRepositories are not
> labelled, fall back to joining the `system-apps` Kustomization's
> `.status.inventory` (object names) with the OCIRepository URLs by object name.

## 5. Data model & API

**New service** `SystemAppsService` (`ui/packages/server/src/installed/`) —
single responsibility: "which apps does this cluster's platform manage?"

```ts
async getSystemApps(): Promise<Map<string, string>>
// catalog app name → Flux Kustomization object name on this cluster
//   'frp-operator'    → 'frp-operator'
//   'nfs-provisioner' → 'storage'
//   'casdoor'         → 'casdoor'
```

- Cached with a short TTL (~30–60s); background-refreshed.
- On k8s-unreachable: return the last-known-good map from cache; on cold start
  with no cache, return an empty map and log. Never throws.

**Type model** (`ui/packages/shared/src/types.ts`) — one runtime-enriched field,
parallel to the existing `installedStatus?`:

```ts
export interface CatalogApp {
  // ...existing fields...
  installedStatus?: AppStatus;
  system?: boolean;   // runtime-derived, per-cluster; absent/false = user app
}
```

`catalog.yaml` is **unchanged**; `system` is enriched at request time.

**API:**
- `GET /api/apps` (Catalog) — **excludes** system apps.
- `GET /api/system-apps` (NEW) — system apps, each enriched with live
  `installedStatus`, for the Platform panel.
- `GET /api/apps/:name` — works for all apps (returns the app with
  `system: true/false`), so a Platform-panel link resolves.
- `GET /api/installed` — unchanged (system apps are not "installed" in the
  Gogs-user-apps sense).

## 6. UX

**Catalog page** — no client change; the server excludes system apps from
`/api/apps`, so `CatalogPage` never receives them.

**Platform panel (new)** — a read-only section on the control-plane page (`/`),
visually distinct from the user-app launcher. It is a **health list, not launch
tiles** (users don't "open" cert-manager):
- Compact rows: icon · name · live `StatusBadge` · version.
- Each links to that app's detail page (read-only).
- Muted styling with a small **"System"** tag / lock icon.
- **Collapsible**, so ~14 infra apps don't overwhelm the launcher on first paint.
- Fed by a new `react-query` key `["system-apps"]`.

**Detail page** (`AppDetailPage`) for `system: true`:
- Shows live status (Running/Error) — the frp-operator fix.
- Install/Uninstall removed; replaced with a disabled, tinted
  **"Managed by platform"** affordance.
- "Open {app}" link hidden for system apps (most have no user-facing UI; the few
  that do are admin surfaces).

**Install/uninstall rejection (defense in depth):**
`POST /api/apps/:name/install` and `/uninstall` call
`SystemAppsService` to check membership and return **409 Conflict** ("<app> is
managed by the platform and cannot be installed/uninstalled") before any Gogs
write. The missing UI button is the first line of defense; this API guard is the
real safety net.

## 7. Status derivation fix

`FluxStatusService.getStatusFor` gains a branch:

```ts
getStatusFor(appName, opts?: { systemKustomization?: string })
//  user app  → current behavior: list by label `marketplace.io/app=<appName>`
//  system app → get the flux-system Kustomization NAMED opts.systemKustomization,
//               derive from its Ready/Healthy conditions
```

`enrich` precedence (**system wins**, so the Gogs "installed?" path is never
consulted for system apps):

```
if systemMap.has(name):       system=true;  status = getStatusFor(name, {systemKustomization})
else if gogsInstalled(name):  system=false; status = getStatusFor(name)        // marketplace label
else:                         system=false; status = 'not_installed'
```

For frp-operator: `systemMap.has('frp-operator')` → queries the `frp-operator`
Kustomization → `Ready=True` → `running`. The stuck badge is resolved.

**Condition precedence fix** (one line; load-bearing for the Platform panel's
error accuracy). Today `Reconciling=True` is checked before `Ready=False`, so a
degraded object holding both returns `installing` and masks the error. Reorder:

```ts
if (ready === 'True') return 'running';
if (ready === 'False') return 'error';        // moved up
if (reconciling === 'True') return 'installing';
return 'installing';
```

## 8. Degradation & edge cases

- **k8s unreachable, warm cache** — `SystemAppsService` returns the last-known
  set; per-app status queries fail and fall back to `installing` (consistent with
  today's degradation). The Platform panel may show a "platform status
  unavailable" note.
- **k8s unreachable, cold start (no cache)** — system set empty → system apps
  fall through to the user path. Rare in production (the in-cluster UI pod
  reaches k8s at boot, warming the cache immediately); the install/uninstall API
  guard still prevents harm. Documented and accepted.
- **App that is both system and in the Gogs user-apps repo** (frp-operator today)
  — the system classification wins; the stale Gogs entry is ignored for UI
  purposes.
- **System app not present in the catalog** (e.g. an Enterprise-only component)
  — its parsed catalog name matches nothing and it is silently not rendered.
  Harmless.

## 9. Testing

**Server unit (vitest):**
- New `system-apps.service.spec.ts` — mock `listNamespacedCustomObject`
  returning OCIRepositories with the system-apps label and `spec.url`s,
  including the `storage`→`nfs-provisioner` mismatch. Assert the
  `Map<catalogName, fluxName>`, caching, and cold-start-unreachable → empty + log.
- Extend `flux-status.service.spec.ts` — system branch
  (`getStatusFor('nfs-provisioner', {systemKustomization:'storage'})` → running)
  and the precedence fix (`Ready=False + Reconciling=True → error`;
  `Ready=True + Reconciling=True → running`).
- Extend `installed.service.spec.ts` — `enrich` precedence, including the
  **failing-first test for the original bug** (frp-operator classified system →
  `running`, not `installing`).
- Server e2e — `GET /api/apps` excludes system apps; `GET /api/system-apps`
  returns them with status; install/uninstall of a system app → **409**.

**Client (jsdom):**
- New Platform panel on `MyAppsPage` renders `["system-apps"]`, shows
  `StatusBadge`, "Managed by platform", no install action, collapsible.
- `AppDetailPage` for `system: true`: hides Install/Uninstall + Open, shows
  status + "Managed by platform".
- `CatalogPage` contract: system apps never appear.

**Browser e2e Tier 1 (hermetic):** Tier 1 pins `KUBECONFIG` to a closed port, so
`SystemAppsService` returns empty. Add a test seam consistent with the existing
hermetic pattern (fixture catalog, dead-port Gogs): an env override
(`SYSTEM_APPS_OVERRIDE=<json>`) that injects a fake system set + statuses when
set. A Tier 1 spec then asserts the Catalog hides system apps, the Platform panel
shows them read-only, and `POST /api/apps/frp-operator/install` → 409.

**Browser e2e Tier 2 (k3d, advisory):** the k3d cluster bootstraps real
system-apps via Flux, so a Tier 2 assertion can verify the Platform panel shows
real system apps (traefik, etc.) as Running. Optional; never a required check.

## 10. Out of scope / future

- Per-app "Open" links for system apps that have a web UI (casdoor, gogs,
  marketplace-ui) — could be re-enabled later, possibly keyed off a future
  metadata field.
- Folding system-app health into the device-status rollup on `/`.
- A dedicated `/platform` route (the panel on `/` covers the need for now).
- Multi-cluster aggregation of platform health.

## 11. Files touched (summary)

- `ui/packages/shared/src/types.ts` — add `system?: boolean` to `CatalogApp`.
- `ui/packages/server/src/installed/system-apps.service.ts` — **new**.
- `ui/packages/server/src/installed/system-apps.service.spec.ts` — **new**.
- `ui/packages/server/src/installed/flux-status.service.ts` — system branch +
  condition precedence.
- `ui/packages/server/src/installed/flux-status.service.spec.ts` — extend.
- `ui/packages/server/src/installed/installed.service.ts` — `enrich` precedence;
  exclude system apps from `/api/apps`; new `/api/system-apps`; install/uninstall
  409 guard.
- `ui/packages/server/src/installed/installed.service.spec.ts` — extend.
- `ui/packages/server/src/installed/installed.module.ts` — register
  `SystemAppsService`.
- `ui/packages/client/src/pages/MyAppsPage.tsx` — Platform panel.
- `ui/packages/client/src/pages/AppDetailPage.tsx` — read-only system treatment.
- New client component(s) for the Platform panel + "Managed by platform" affordance.
- `ui/packages/e2e/` — Tier 1 spec + `SYSTEM_APPS_OVERRIDE` seam support.
