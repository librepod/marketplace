---
phase: 03-installed-apps-live-status
plan: "03"
subsystem: server-implementation
tags: [nestjs, gogs, kubernetes, flux, installed-apps, green-phase, tdd]
dependency_graph:
  requires:
    - BACK-02 unit test contract (03-01: gogs.service.spec.ts)
    - BACK-03 unit test contract (03-01: flux-status.service.spec.ts)
    - enrichment composition tests (03-01: installed.service.spec.ts)
    - e2e installedStatus + GET /api/installed tests (03-01: catalog.e2e-spec.ts)
  provides:
    - GogsService: Gogs HTTP API client (BACK-02 GREEN)
    - FluxStatusService: k8s CRD queries via @kubernetes/client-node (BACK-03 GREEN)
    - InstalledService: enrich() and getInstalled() composition
    - InstalledController: GET /api/installed endpoint
    - InstalledModule: NestJS module registration
    - AppStatus type exported from @librepod/shared
    - installedStatus field on CatalogApp (shared + server)
  affects:
    - ui/packages/shared/src/types.ts
    - ui/packages/server/src/catalog/catalog.types.ts
    - ui/packages/server/src/catalog/catalog.module.ts
    - ui/packages/server/src/catalog/catalog.controller.ts
    - ui/packages/server/src/app.module.ts
    - ui/packages/server/src/installed/ (new directory, 5 files)
tech_stack:
  added:
    - "@kubernetes/client-node@^1.4.0 — official Kubernetes JS client for FluxCD CRD queries"
  patterns:
    - NestJS forwardRef() circular dependency resolution (CatalogModule ↔ InstalledModule)
    - Promise.all fan-out for concurrent per-app FluxCD status queries
    - KUBERNETES_SERVICE_HOST env check for loadFromCluster vs loadFromDefault fallback
    - Graceful degradation — GogsService returns [] on error, FluxStatusService returns 'installing' on error
key_files:
  created:
    - ui/packages/server/src/installed/gogs.service.ts
    - ui/packages/server/src/installed/flux-status.service.ts
    - ui/packages/server/src/installed/installed.service.ts
    - ui/packages/server/src/installed/installed.controller.ts
    - ui/packages/server/src/installed/installed.module.ts
    - ui/packages/server/src/installed/installed.types.ts
  modified:
    - ui/packages/shared/src/types.ts (added AppStatus type + installedStatus? field)
    - ui/packages/server/src/catalog/catalog.types.ts (mirrored AppStatus + installedStatus?)
    - ui/packages/server/src/catalog/catalog.module.ts (forwardRef InstalledModule, export CatalogService)
    - ui/packages/server/src/catalog/catalog.controller.ts (inject InstalledService, async enrich)
    - ui/packages/server/src/app.module.ts (add InstalledModule)
decisions:
  - "forwardRef() used for CatalogModule ↔ InstalledModule circular dependency — InstalledModule imports CatalogModule for CatalogService; CatalogModule imports InstalledModule for InstalledService injection into CatalogController"
  - "AppStatus type lives in @librepod/shared as source of truth; catalog.types.ts re-exports it for server-internal use"
  - "CatalogController.findOne() also enriched with installedStatus via InstalledService.enrich([app]) for single-app detail view"
metrics:
  duration: "~5 minutes"
  completed_date: "2026-04-25"
  tasks_completed: 2
  files_created: 6
  files_modified: 5
---

# Phase 3 Plan 3: Backend Implementation (GREEN Phase) Summary

**One-liner:** NestJS InstalledModule with GogsService (Gogs HTTP raw-file fetch) and FluxStatusService (@kubernetes/client-node CRD label-selector queries) enriching every GET /api/apps response with installedStatus and powering the new GET /api/installed endpoint — all 47 server tests GREEN.

## What Was Built

### Task 1: Types + Leaf Services

**`@librepod/shared` types.ts** — Added `AppStatus` union type and optional `installedStatus?: AppStatus` field to `CatalogApp`. `CatalogFile` unchanged.

**`catalog.types.ts`** — Mirrored `AppStatus` import and `installedStatus?` field. Server-internal types stay in sync with shared package.

**`installed.types.ts`** — Defines `FluxCondition` interface with `type`, `status`, `reason?`, `message?` fields used for CRD condition parsing.

**`gogs.service.ts`** — Fetches `kustomization.yaml` raw file from Gogs API (`/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml`) with Bearer token auth. Parses YAML `resources:` list, strips trailing slashes (Pitfall 7). Returns `[]` on non-OK response or network error (graceful degradation).

**`flux-status.service.ts`** — Queries FluxCD Kustomizations (`kustomize.toolkit.fluxcd.io/v1`) then HelmReleases (`helm.toolkit.fluxcd.io/v2`) by label selector `marketplace.io/app={appName}` in `flux-system` namespace. Uses `KUBERNETES_SERVICE_HOST` env check to choose `loadFromCluster()` vs `loadFromDefault()` (Pitfall 5). Derives status from `Ready`/`Reconciling` conditions. Returns `'installing'` on any k8s error.

### Task 2: Composition + Wiring

**`installed.service.ts`** — `enrich(apps)` calls GogsService once, builds a Set of installed names, then fans out FluxStatusService calls via `Promise.all` for installed apps only (not-installed apps skip k8s calls entirely). `getInstalled()` calls `enrich(catalog.findAll())` and filters to non-`not_installed` entries.

**`installed.controller.ts`** — `GET /api/installed` endpoint returning `InstalledService.getInstalled()`.

**`installed.module.ts`** — Registers all providers, imports `forwardRef(() => CatalogModule)` to get `CatalogService`, exports `InstalledService` for CatalogModule consumption.

**`catalog.module.ts`** — Added `forwardRef(() => InstalledModule)` import and `exports: [CatalogService]` to complete the circular dependency resolution.

**`catalog.controller.ts`** — `findAll()` made async, now calls `installedService.enrich(apps)`. `findOne()` also enriches the single app result.

**`app.module.ts`** — Added `InstalledModule` to imports array.

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Install @kubernetes/client-node, add AppStatus type, create GogsService and FluxStatusService | 36cdba7 | types.ts, catalog.types.ts, installed.types.ts, gogs.service.ts, flux-status.service.ts, package.json |
| 2 | InstalledModule wiring — all server unit and e2e tests GREEN | 335082d | installed.service.ts, installed.controller.ts, installed.module.ts, catalog.module.ts, catalog.controller.ts, app.module.ts |

## Verification

**Unit tests (33 passing):**
- `gogs.service.spec.ts`: 7 tests — happy path, trailing slash strip, 404, network error, missing resources key, auth header
- `flux-status.service.spec.ts`: 10 tests — all 4 status outcomes, HelmRelease fallback, label selector, API group/version/plural assertions
- `installed.service.spec.ts`: 7 tests — enrich not-installed, enrich installed, Promise.all fan-out, no flux calls for not-installed, getInstalled filter, empty array
- `catalog.service.spec.ts`: 9 tests — pre-existing, still passing

**E2e tests (14 passing):**
- Original 10 tests (GET /api/apps, GET /api/apps/:name, GET /api/health) — all pass
- 3 new installedStatus tests — field present, valid value, all not_installed when Gogs unreachable
- 3 new GET /api/installed tests — 200 array, empty array when Gogs unreachable, each item has installedStatus

**TypeScript:** `npx tsc --noEmit` exits 0 — no errors.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All production functionality is wired. The graceful degradation paths (Gogs unreachable → `not_installed`, k8s unreachable → `installing`) are intentional behavior, not stubs.

## Threat Flags

None. No new network endpoints, auth paths, or schema changes beyond what the plan's threat model covers:
- T-03-03: GOGS_TOKEN read from env var, never logged (implemented: logger.warn logs only error message)
- T-03-05: appName validated against catalog before k8s label selector call (implemented: CatalogService.findOne returns undefined for unknown names → NotFoundException before enrich)

## Self-Check: PASSED

- [x] `ui/packages/shared/src/types.ts` contains `export type AppStatus = 'not_installed' | 'installing' | 'running' | 'error';`
- [x] `ui/packages/shared/src/types.ts` contains `installedStatus?: AppStatus;`
- [x] `ui/packages/server/src/catalog/catalog.types.ts` contains `installedStatus?: AppStatus;`
- [x] `ui/packages/server/src/installed/installed.types.ts` contains `FluxCondition` interface
- [x] `ui/packages/server/src/installed/gogs.service.ts` contains `r.replace(/\/$/, '')`
- [x] `ui/packages/server/src/installed/gogs.service.ts` contains `Authorization: \`token ${this.gogsToken}\``
- [x] `ui/packages/server/src/installed/flux-status.service.ts` contains `process.env.KUBERNETES_SERVICE_HOST`
- [x] `ui/packages/server/src/installed/flux-status.service.ts` contains `kustomize.toolkit.fluxcd.io` and `helm.toolkit.fluxcd.io`
- [x] `ui/packages/server/src/installed/installed.service.ts` contains `Promise.all(`
- [x] `ui/packages/server/src/installed/installed.module.ts` contains `forwardRef(() => CatalogModule)`
- [x] `ui/packages/server/src/catalog/catalog.module.ts` contains `forwardRef(() => InstalledModule)` and `exports: [CatalogService]`
- [x] `ui/packages/server/src/catalog/catalog.controller.ts` contains `async findAll(): Promise<CatalogApp[]>`
- [x] `ui/packages/server/src/app.module.ts` contains `InstalledModule`
- [x] `@kubernetes/client-node` in server package.json
- [x] Commit 36cdba7 exists
- [x] Commit 335082d exists
- [x] All 33 unit tests pass GREEN
- [x] All 14 e2e tests pass GREEN
- [x] TypeScript compilation clean
