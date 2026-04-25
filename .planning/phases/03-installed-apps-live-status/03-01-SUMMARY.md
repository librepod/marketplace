---
phase: 03-installed-apps-live-status
plan: "01"
subsystem: server-tests
tags: [tdd, red-phase, gogs, flux, installed-apps, nestjs]
dependency_graph:
  requires: []
  provides:
    - BACK-02 unit test contract (gogs.service.spec.ts)
    - BACK-03 unit test contract (flux-status.service.spec.ts)
    - enrichment composition tests (installed.service.spec.ts)
    - e2e coverage for installedStatus and GET /api/installed
  affects:
    - ui/packages/server/src/installed/ (new directory)
    - ui/packages/server/test/catalog.e2e-spec.ts
tech_stack:
  added: []
  patterns:
    - NestJS TestingModule with mocked providers (vi.fn())
    - vi.spyOn(global, 'fetch') for HTTP service testing
    - vi.mock('@kubernetes/client-node') for k8s client isolation
    - RED phase TDD — import errors are the expected failure mode
key_files:
  created:
    - ui/packages/server/src/installed/gogs.service.spec.ts
    - ui/packages/server/src/installed/flux-status.service.spec.ts
    - ui/packages/server/src/installed/installed.service.spec.ts
  modified:
    - ui/packages/server/test/catalog.e2e-spec.ts
decisions:
  - "vi.mock('@kubernetes/client-node') hoisted at module level to intercept KubeConfig before onModuleInit runs"
  - "GOGS_URL=http://localhost:9999 in e2e test env causes fetch ECONNREFUSED → GogsService returns [] → graceful degradation path exercised"
  - "e2e new describe blocks appended after existing GET /api/health block to preserve all 10 original tests"
metrics:
  duration: "~3 minutes"
  completed_date: "2026-04-25"
  tasks_completed: 2
  files_created: 3
  files_modified: 1
---

# Phase 3 Plan 1: Wave 0 RED Test Stubs Summary

**One-liner:** Failing unit and e2e test stubs for GogsService (fetch-based Gogs API), FluxStatusService (k8s CRD queries), InstalledService (enrichment composition), and installedStatus e2e assertions — all in RED state awaiting production code in Plan 03-03.

## What Was Built

Four test files establish the verification contract for Phase 3 backend work:

1. **gogs.service.spec.ts** — 6 unit tests covering `getInstalledAppNames()`: happy path (YAML parsing), trailing slash stripping (Pitfall 7), 404 response, network error, missing `resources` key, and auth header assertion. Uses `vi.spyOn(global, 'fetch')`.

2. **flux-status.service.spec.ts** — 9 unit tests covering `getStatusFor()`: all four status derivation outcomes (running/installing/error/graceful-degradation), HelmRelease fallback when no Kustomization found, label selector assertion (`marketplace.io/app=vaultwarden`), and API group/version/plural assertions for both CRD types. Uses `vi.mock('@kubernetes/client-node')` hoisted before imports.

3. **installed.service.spec.ts** — 6 unit tests covering `enrich()` (not-installed, installed with flux status, Promise.all fan-out, no unnecessary flux calls) and `getInstalled()` (filtered list, empty array). All dependencies mocked via NestJS provider overrides.

4. **catalog.e2e-spec.ts** (extended) — Added `GOGS_URL`/`GOGS_TOKEN` env vars at top, plus 3 tests for `installedStatus` field on `GET /api/apps` and 3 tests for `GET /api/installed`. All 10 original tests preserved unchanged.

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | GogsService and FluxStatusService unit test stubs | 259b65b | gogs.service.spec.ts, flux-status.service.spec.ts |
| 2 | InstalledService spec and e2e extension | ff22625 | installed.service.spec.ts, catalog.e2e-spec.ts |

## Verification

All three new unit spec files fail with expected import errors (RED state):
- `gogs.service.spec.ts`: `Failed to load url ./gogs.service`
- `flux-status.service.spec.ts`: `Failed to load url ./flux-status.service`
- `installed.service.spec.ts`: `Failed to load url ./installed.service`

Existing 9 unit tests in `catalog.service.spec.ts` continue to pass.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. Test files import non-existent production modules intentionally — this is the RED phase. No production code stubs were created in this plan.

## Threat Flags

None. Test files contain only mock credentials (`mock-token`, `test-token`) — no real secrets.

## Self-Check: PASSED

- [x] `ui/packages/server/src/installed/gogs.service.spec.ts` exists
- [x] `ui/packages/server/src/installed/flux-status.service.spec.ts` exists
- [x] `ui/packages/server/src/installed/installed.service.spec.ts` exists
- [x] `ui/packages/server/test/catalog.e2e-spec.ts` contains `process.env.GOGS_URL`
- [x] Commits 259b65b and ff22625 exist in git log
- [x] All three new spec files fail with import errors (RED state confirmed)
- [x] Existing catalog.service.spec.ts 9 tests still pass
