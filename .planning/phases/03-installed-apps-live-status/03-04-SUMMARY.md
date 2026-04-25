---
phase: 03-installed-apps-live-status
plan: "04"
subsystem: client-implementation
tags: [tdd, green-phase, frontend, status-badge, my-apps, react, react-router]
dependency_graph:
  requires:
    - StatusBadge RED tests (03-02: StatusBadge.test.tsx)
    - MyAppsPage RED tests (03-02: MyAppsPage.test.tsx)
    - AppStatus type from @librepod/shared (03-03)
    - installedStatus? field on CatalogApp (03-03)
  provides:
    - StatusBadge component (STAT-01 GREEN)
    - MyAppsPage at /my-apps (INST-03 GREEN)
    - AppCard status overlay (conditional StatusBadge)
    - AppShell nav bar (Catalog + My Apps NavLinks)
    - AppDetailPage status badge integration
  affects:
    - ui/packages/client/src/components/StatusBadge.tsx (created)
    - ui/packages/client/src/components/AppCard.tsx (modified)
    - ui/packages/client/src/components/AppShell.tsx (modified)
    - ui/packages/client/src/pages/MyAppsPage.tsx (created)
    - ui/packages/client/src/pages/AppDetailPage.tsx (modified)
    - ui/packages/client/src/router.tsx (modified)
tech_stack:
  added: []
  patterns:
    - STATUS_CONFIG lookup table with label + dot class per status value
    - Exclude<AppStatus, 'not_installed'> prop type for compile-time safety
    - NavLink with isActive callback for active state styling
    - Inline empty state copy for MyAppsPage (avoids modifying shared EmptyState component)
    - Conditional StatusBadge render guarded by installedStatus !== 'not_installed'
key_files:
  created:
    - ui/packages/client/src/components/StatusBadge.tsx
    - ui/packages/client/src/pages/MyAppsPage.tsx
  modified:
    - ui/packages/client/src/components/AppCard.tsx
    - ui/packages/client/src/components/AppShell.tsx
    - ui/packages/client/src/pages/AppDetailPage.tsx
    - ui/packages/client/src/router.tsx
decisions:
  - "Inline empty state in MyAppsPage ('No apps installed yet') rather than modifying shared EmptyState component — avoids regression risk; EmptyState has hardcoded 'No apps available' text with no custom message prop"
  - "role=status on StatusBadge span for semantic ARIA correctness; test uses getByRole('status') ?? document.body fallback"
  - "MyAppsPage uses 6 skeletons vs CatalogPage's 12 — installed list expected to be smaller than full catalog"
  - "AppShell header text changed from 'App Catalog' to 'LibrePod' with subtitle 'Self-hosted apps, one click away' — no existing AppShell tests assert on header text, so no regression"
metrics:
  duration: "~8 minutes"
  completed_date: "2026-04-25"
  tasks_completed: 2
  files_created: 2
  files_modified: 4
---

# Phase 03 Plan 04: Client Implementation (GREEN Phase) Summary

**One-liner:** React StatusBadge component with STATUS_CONFIG lookup, MyAppsPage fetching /api/installed, AppCard overlay and AppDetailPage badge for installed-status display, AppShell nav bar with Catalog/My Apps NavLinks — turning all 13 RED client tests GREEN while keeping 21 pre-existing Phase 2 tests passing.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | StatusBadge component and AppCard status overlay | 6526758 | StatusBadge.tsx (created), AppCard.tsx (modified) |
| 2 | AppShell nav bar, MyAppsPage, AppDetailPage status badge, router | 9983dca | AppShell.tsx, MyAppsPage.tsx (created), AppDetailPage.tsx, router.tsx |

## What Was Built

### Task 1: StatusBadge + AppCard

**`StatusBadge.tsx`** — New component with a `STATUS_CONFIG` constant object mapping each installed status to its label string and Tailwind dot color class:
- `running` → label `'Running'`, dot `bg-green-500`
- `installing` → label `'Installing'`, dot `bg-yellow-400`
- `error` → label `'Error'`, dot `bg-red-500`

Prop type is `Exclude<AppStatus, 'not_installed'>` — TypeScript rejects `not_installed` at compile time. Component has `role="status"` for semantic ARIA. Renders a flex span with colored dot + label text.

**`AppCard.tsx`** — Added `<div className="relative">` wrapper around card body contents. Conditional StatusBadge overlay positioned `absolute right-0 top-0 z-10`. Guard: `app.installedStatus && app.installedStatus !== 'not_installed'` — badge absent when status is undefined or `'not_installed'`. All existing card content (AppIcon, display name, category badge, description) unchanged.

### Task 2: AppShell, MyAppsPage, AppDetailPage, router

**`AppShell.tsx`** — Replaced static `<header>` with nav-enabled header. Added `<nav>` with two `NavLink` elements using `isActive` callback to apply `text-foreground` (active) vs `text-muted-foreground` (inactive) classes. Catalog links to `/` with `end` prop; My Apps links to `/my-apps`. Outer div structure and `<Outlet />` placement unchanged.

**`MyAppsPage.tsx`** — Mirrors `CatalogPage.tsx` pattern exactly: same `GRID_STYLE`, same `AppCard`/`AppCardSkeleton`/`ErrorBlock` imports, same four render branches (loading/error/empty/data). Differences: `queryKey: ["installed"]`, `fetch("/api/installed")`, 6 skeletons instead of 12, inline empty state `<p>No apps installed yet.</p>` instead of shared `EmptyState`.

**`AppDetailPage.tsx`** — Added `import { StatusBadge }` and conditional render block between the badges row (category + version) and `<Separator className="my-6" />`. Guard identical to AppCard: `data.installedStatus && data.installedStatus !== 'not_installed'`.

**`router.tsx`** — Added `import { MyAppsPage }` and `{ path: "/my-apps", element: <MyAppsPage /> }` as sibling child under AppShell.

## Verification

**Client unit tests (34 passing):**
- `StatusBadge.test.tsx`: 7 tests — Running/Installing/Error labels, dot colors, prop type runtime check
- `MyAppsPage.test.tsx`: 6 tests — loading skeletons, Vaultwarden card, error block, empty state, /api/installed endpoint, StatusBadge visible for running app
- `AppCard.test.tsx`: 5 tests — all pre-existing, still GREEN after relative wrapper addition
- `AppDetailPage.test.tsx`, `CatalogPage.test.tsx`, `AppCardSkeleton.test.tsx`, `ErrorBlock.test.tsx`: all pre-existing, all GREEN

**Server unit tests (33 passing):** All pre-existing — GogsService, FluxStatusService, InstalledService, CatalogService.

**TypeScript:** `npx tsc -p tsconfig.app.json --noEmit` exits 0 — no type errors. (Root `tsconfig.json` emits a pre-existing TS5101 deprecation warning unrelated to this plan.)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All components are fully implemented and wired. EmptyState is intentionally not reused for MyAppsPage (different copy required, no custom message prop available) — the inline empty state is production-ready, not a stub.

## Threat Flags

None. No new network endpoints, auth paths, file access patterns, or schema changes beyond the plan's threat model:
- T-03-07: STATUS_CONFIG handles only three known values; unknown status falls through to undefined (cfg is undefined) — acceptable, backend validates the type before sending
- T-03-08: NavLink active state is purely cosmetic CSS

## Self-Check: PASSED

- [x] `ui/packages/client/src/components/StatusBadge.tsx` exists and exports `StatusBadge`
- [x] StatusBadge.tsx contains `STATUS_CONFIG` with labels `'Running'`, `'Installing'`, `'Error'`
- [x] StatusBadge.tsx contains `bg-green-500`, `bg-yellow-400`, `bg-red-500`
- [x] StatusBadge.tsx prop type is `Exclude<AppStatus, 'not_installed'>`
- [x] `ui/packages/client/src/components/AppCard.tsx` contains `import { StatusBadge }`
- [x] AppCard.tsx contains `app.installedStatus !== 'not_installed'`
- [x] AppCard.tsx contains `<div className="relative">`
- [x] `ui/packages/client/src/components/AppShell.tsx` contains `NavLink` and `to="/my-apps"`
- [x] AppShell.tsx contains `to="/"` with `end` prop
- [x] AppShell.tsx contains `isActive ? "text-foreground" : "text-muted-foreground"`
- [x] `ui/packages/client/src/pages/MyAppsPage.tsx` exists and exports `MyAppsPage`
- [x] MyAppsPage.tsx contains `queryKey: ["installed"]` and `fetch("/api/installed")`
- [x] MyAppsPage.tsx contains `No apps installed yet`
- [x] `ui/packages/client/src/pages/AppDetailPage.tsx` imports `StatusBadge`
- [x] AppDetailPage.tsx renders `<StatusBadge status={data.installedStatus} />` conditionally
- [x] `ui/packages/client/src/router.tsx` contains `path: "/my-apps"` and `element: <MyAppsPage />`
- [x] Commit 6526758 exists (Task 1)
- [x] Commit 9983dca exists (Task 2)
- [x] All 34 client tests GREEN
- [x] All 33 server tests GREEN
- [x] TypeScript clean (tsconfig.app.json)
