---
phase: 04-install-uninstall
plan: 02
subsystem: [api]
tags: [nestjs, async-mutex, gogs, crypto]

# Dependency graph
requires:
  - phase: 04-01
    provides: "Shared types, test scaffolds, catalog templates"
provides:
  - "POST /api/apps/:name/install endpoint"
  - "POST /api/apps/:name/uninstall endpoint"
  - "InstalledService.install() with mutex, template rendering, secret generation"
  - "InstalledService.uninstall() with mutex"
  - "GogsService write methods: createFile, getFileContents, addToRootKustomization, removeFromRootKustomization"
affects: [04-03]

# Tech tracking
tech-stack:
  added: [async-mutex]
  patterns: [mutex-serialization, template-variable-substitution, crypto-secret-generation]

key-files:
  created: []
  modified:
    - ui/packages/server/src/installed/gogs.service.ts
    - ui/packages/server/src/installed/installed.service.ts
    - ui/packages/server/src/catalog/catalog.controller.ts
    - ui/packages/server/src/installed/installed.service.spec.ts
    - ui/packages/server/package.json

key-decisions:
  - "Single mutex for all install/uninstall ops — acceptable for v1 single-pod"
  - "Leave orphaned files on uninstall (Gogs has no DELETE API)"
  - "Template variables from env vars and crypto.randomBytes — no user input"

patterns-established:
  - "Mutex serialization: async-mutex runExclusive wraps install/uninstall"
  - "Template rendering: ${VAR} regex substitution with fallback passthrough"
  - "File write order: app files first, root kustomization last (install); reverse for uninstall"

requirements-completed: [INST-01, INST-02, BACK-04]

# Metrics
duration: 10min
completed: 2026-04-26
---

# Phase 04: Install/Uninstall Plan 02 Summary

**Backend install/uninstall pipeline with mutex-serialized Gogs commits and POST endpoints**

## Performance

- **Duration:** 10 min
- **Started:** 2026-04-26T23:22:00Z
- **Completed:** 2026-04-26T23:32:00Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- GogsService extended with createFile, getFileContents, addToRootKustomization, removeFromRootKustomization
- InstalledService.install() renders templates with variable substitution, generates crypto secrets, writes files to Gogs
- InstalledService.uninstall() removes app from root kustomization
- Mutex serializes all concurrent install/uninstall operations
- POST /api/apps/:name/install and POST /api/apps/:name/uninstall endpoints

## Task Commits

1. **Task 1: GogsService write methods** - `340e8b4` (feat)
2. **Task 2: InstalledService + controller endpoints** - `313294e` (feat)

## Files Created/Modified
- `ui/packages/server/src/installed/gogs.service.ts` - Added createFile, getFileContents, addToRootKustomization, removeFromRootKustomization
- `ui/packages/server/src/installed/installed.service.ts` - Added install(), uninstall(), renderTemplate(), generateSecret() with mutex
- `ui/packages/server/src/catalog/catalog.controller.ts` - Added POST :name/install and POST :name/uninstall with @HttpCode(200)
- `ui/packages/server/src/installed/installed.service.spec.ts` - Added ConfigService mock for new dependency
- `ui/packages/server/package.json` - Added async-mutex dependency

## Decisions Made
- Single mutex for all operations — acceptable for v1 single-pod, operations are short-lived (~2-3s)
- Orphaned files left on uninstall — Gogs has no DELETE API, files are unreferenced and harmless
- Template variable injection mitigated: vars come from ConfigService env and crypto.randomBytes only

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None

## Next Phase Readiness
- Backend install/uninstall fully functional — Plan 04-03 can wire up the frontend
- All 49 server tests GREEN (14 GogsService + 19 InstalledService + 7 CatalogService + 9 FluxStatusService)

---
*Phase: 04-install-uninstall*
*Completed: 2026-04-26*
