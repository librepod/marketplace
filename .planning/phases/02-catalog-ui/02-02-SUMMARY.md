---
phase: 02-catalog-ui
plan: "02"
subsystem: testing
tags: [vitest, react-testing-library, jest-dom, tanstack-query, react-router, typescript]

# Dependency graph
requires:
  - phase: 02-01
    provides: Vite scaffold with vitest.config.ts (setupFiles: ["./src/test/setup.ts"]) already configured

provides:
  - Vitest setup file (src/test/setup.ts) that makes jest-dom matchers available globally
  - AppCard.test.tsx — test contract for card component covering CAT-01, CAT-03
  - AppCardSkeleton.test.tsx — test contract covering STAT-02 (200px fixed height)
  - ErrorBlock.test.tsx — test contract covering STAT-02 (copy strings, retry button)
  - CatalogPage.test.tsx — test contract covering CAT-01, STAT-02 (12 skeletons, error, empty, title)
  - AppDetailPage.test.tsx — test contract covering CAT-02 (name/version/category/desc, back link, install btn, view source, 404)

affects:
  - 02-04 (component implementations must satisfy these test contracts)
  - 02-05 (page implementations must satisfy these test contracts)
  - 02-06 (integration phase can run vitest to verify full TDD GREEN gate)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - MemoryRouter wrapper for components using useNavigate or Link
    - QueryClientProvider wrapper with retry:0 for TanStack Query in tests
    - vi.spyOn(global, 'fetch') for stubbing API calls in unit tests
    - data-testid="app-card-skeleton" for counting skeleton cards by selector

key-files:
  created:
    - ui/packages/client/src/test/setup.ts
    - ui/packages/client/src/components/AppCard.test.tsx
    - ui/packages/client/src/components/AppCardSkeleton.test.tsx
    - ui/packages/client/src/components/ErrorBlock.test.tsx
    - ui/packages/client/src/pages/CatalogPage.test.tsx
    - ui/packages/client/src/pages/AppDetailPage.test.tsx
  modified: []

key-decisions:
  - "Tests are in failing (RED) state by design — components don't exist yet; import errors are the expected failure mode"
  - "CatalogPage skeleton count test uses data-testid='app-card-skeleton' selector; Plan 04 must add this attribute to AppCardSkeleton"
  - "AppDetailPage wrapper uses MemoryRouter initialEntries + Routes/Route to provide :name param via useParams"

patterns-established:
  - "React component test wrapper: MemoryRouter + QueryClientProvider (retry:0) for pages with data fetching"
  - "vi.spyOn(global, 'fetch') pattern for API stubbing (no MSW dependency needed for these tests)"
  - "Exact copy strings from UI-SPEC Copywriting Contract used as test assertions"

requirements-completed:
  - CAT-01
  - CAT-02
  - CAT-03
  - STAT-02

# Metrics
duration: 8min
completed: "2026-04-21"
---

# Phase 2 Plan 02: Test Scaffolds Summary

**Five test contracts for catalog UI components — all in failing RED state awaiting implementation in Wave 3**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-21T12:12:14Z
- **Completed:** 2026-04-21T12:20:39Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Created src/test/setup.ts with @testing-library/jest-dom import (makes toBeInTheDocument() etc. available globally via vitest setupFiles)
- Created three component test files (AppCard, AppCardSkeleton, ErrorBlock) covering CAT-01, CAT-03, STAT-02 with exact UI-SPEC copy strings
- Created two page test files (CatalogPage, AppDetailPage) with TanStack Query + React Router wrappers, fetch spying, and all CAT-02 behavioral assertions

## Task Commits

1. **Task 1: Write Vitest setup file and AppCard + AppCardSkeleton + ErrorBlock tests** - `767d45c` (test)
2. **Task 2: Write CatalogPage and AppDetailPage test scaffolds** - `4f9909b` (test)

## Files Created/Modified

- `ui/packages/client/src/test/setup.ts` - Single-line jest-dom import; loaded by vitest setupFiles before every test
- `ui/packages/client/src/components/AppCard.test.tsx` - 5 tests: display name, description, category badge, icon img, no version on card
- `ui/packages/client/src/components/AppCardSkeleton.test.tsx` - 2 tests: renders without crash, 200px fixed height
- `ui/packages/client/src/components/ErrorBlock.test.tsx` - 4 tests: error heading, error body, retry button, click handler
- `ui/packages/client/src/pages/CatalogPage.test.tsx` - 5 tests: 12 skeletons, cards after load, error block, empty state, page title
- `ui/packages/client/src/pages/AppDetailPage.test.tsx` - 5 tests: full content, back link, disabled install btn, view source link, 404 state

## Decisions Made

- Tests are intentionally in failing (RED) state — this is the correct outcome. Import failures (component not found) are the expected error mode, not syntax errors.
- CatalogPage skeleton count test relies on `data-testid="app-card-skeleton"` — Plan 04 must add this attribute to AppCardSkeleton when implementing it.
- AppDetailPage test uses `MemoryRouter initialEntries={['/apps/vaultwarden']}` with `<Routes><Route path="/apps/:name" element={children} /></Routes>` to expose the `:name` param to `useParams()`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Known Stubs

None in this plan — all files are test files with no data rendering.

## Threat Flags

None — test files only; no network endpoints, auth paths, or schema changes introduced.

## Next Phase Readiness

- All test contracts established; Wave 3 plans (02-03 shell, 02-04 components, 02-05 pages) can now implement against these
- Wave 3 executor should run `npm test --workspace=packages/client` to verify GREEN gate after implementing components
- Plan 04 implementor must add `data-testid="app-card-skeleton"` to AppCardSkeleton for the 12-skeleton count test to pass

---
*Phase: 02-catalog-ui*
*Completed: 2026-04-21*

## Self-Check: PASSED

- All 6 files exist on disk
- Commit 767d45c exists (Task 1)
- Commit 4f9909b exists (Task 2)
