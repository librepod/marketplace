---
phase: 03-installed-apps-live-status
plan: "02"
subsystem: client-tests
tags: [tdd, red-phase, frontend, status-badge, my-apps]
dependency_graph:
  requires: []
  provides:
    - StatusBadge unit test stubs (STAT-01)
    - MyAppsPage unit test stubs (INST-03)
  affects:
    - ui/packages/client/src/components/StatusBadge.tsx (will be created in 03-04)
    - ui/packages/client/src/pages/MyAppsPage.tsx (will be created in 03-04)
tech_stack:
  added: []
  patterns:
    - vitest + @testing-library/react for client component tests
    - vi.spyOn(global, 'fetch') for fetch mocking
    - createWrapper with QueryClient + MemoryRouter
key_files:
  created:
    - ui/packages/client/src/components/StatusBadge.test.tsx
    - ui/packages/client/src/pages/MyAppsPage.test.tsx
  modified: []
decisions: []
metrics:
  duration: "~5 minutes"
  completed: "2026-04-25"
---

# Phase 03 Plan 02: Client Test Stubs (RED Phase) Summary

**One-liner:** RED-phase vitest stubs for StatusBadge and MyAppsPage — 13 test cases asserting dot colors, label text, fetch endpoint, and empty state copy, all failing at import time.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | StatusBadge component test stubs | 0244301 | ui/packages/client/src/components/StatusBadge.test.tsx |
| 2 | MyAppsPage component test stubs | dfcf1c6 | ui/packages/client/src/pages/MyAppsPage.test.tsx |

## What Was Built

### StatusBadge.test.tsx (7 test cases)
- `renders "Running" label` — asserts screen.getByText('Running') for status="running"
- `renders a green dot indicator` — asserts container.querySelector('.bg-green-500')
- `renders "Installing" label` — asserts screen.getByText('Installing') for status="installing"
- `renders a yellow dot indicator` — asserts container.querySelector('.bg-yellow-400')
- `renders "Error" label` — asserts screen.getByText('Error') for status="error"
- `renders a red dot indicator` — asserts container.querySelector('.bg-red-500')
- `StatusBadge prop type excludes not_installed` — runtime type-safety validation for Exclude<AppStatus, 'not_installed'>

### MyAppsPage.test.tsx (6 test cases)
- `shows loading state while fetching installed apps` — asserts skeletons.length > 0 during pending fetch
- `renders installed app cards after data loads` — asserts screen.getByText('Vaultwarden')
- `shows error block on fetch failure` — asserts /failed to/i text on 500 response
- `shows empty state when no apps installed` — asserts /no apps installed/i
- `fetches from /api/installed endpoint` — asserts fetchSpy.toHaveBeenCalledWith('/api/installed')
- `installed app cards show StatusBadge when installedStatus is running` — asserts screen.getByText('Running')

## Verification

Both test files are in confirmed RED state (import error for non-existent production modules):
- `StatusBadge.test.tsx` → `Cannot find module './StatusBadge'`
- `MyAppsPage.test.tsx` → `Cannot find module './MyAppsPage'`

Existing Phase 2 client tests remain passing:
- `CatalogPage.test.tsx`: 5/5 tests pass

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

Both test files are intentional RED-phase stubs. The production components they import do not exist yet and will be created in Plan 03-04. This is the expected TDD RED state, not an unintentional stub.

## Self-Check: PASSED

- [x] ui/packages/client/src/components/StatusBadge.test.tsx exists
- [x] ui/packages/client/src/pages/MyAppsPage.test.tsx exists
- [x] Commit 0244301 exists (StatusBadge test)
- [x] Commit dfcf1c6 exists (MyAppsPage test)
- [x] Both files fail at import time (RED state confirmed)
- [x] CatalogPage.test.tsx still passes (5/5)
