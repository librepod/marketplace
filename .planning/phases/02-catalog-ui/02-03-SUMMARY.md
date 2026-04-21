---
phase: 02-catalog-ui
plan: 03
subsystem: ui
tags: [react, vite, react-router, tanstack-query, shadcn, tailwind, typescript]

requires:
  - phase: 02-01
    provides: Vite scaffold with shadcn, Tailwind v4, vitest configured

provides:
  - React entry point (main.tsx) with dark mode init, QueryClient, RouterProvider
  - Client-side router (router.tsx) with / and /apps/:name routes nested under AppShell
  - AppShell layout component with header, separator, and Outlet
  - Page stubs for CatalogPage and AppDetailPage (Plan 05 replaces these)

affects: [02-04, 02-05, 02-06]

tech-stack:
  added: []
  patterns:
    - "Dark mode init via classList.add('dark') before ReactDOM.createRoot to prevent FOUC"
    - "QueryClient configured with 5min staleTime and retry:0 for manual retry UX"
    - "Routes nested under AppShell element using React Router v6 Outlet pattern"
    - "AppShell as persistent page frame — pages slot in via <Outlet />"

key-files:
  created:
    - ui/packages/client/src/router.tsx
    - ui/packages/client/src/components/AppShell.tsx
    - ui/packages/client/src/pages/CatalogPage.tsx
    - ui/packages/client/src/pages/AppDetailPage.tsx
  modified:
    - ui/packages/client/src/main.tsx

key-decisions:
  - "Dark mode class set on <html> before React mount to prevent flash of unstyled content"
  - "QueryClient retry:0 — user-triggered Retry button (Plan 05) instead of automatic retries"
  - "Routes nested under AppShell using Outlet pattern so shell renders once for all pages"

patterns-established:
  - "AppShell wraps all routes via Outlet — add new routes to router.tsx, they inherit shell"
  - "Page stubs pattern: create minimal export to satisfy TypeScript imports, replace later"

requirements-completed: [CAT-01, CAT-02]

duration: 13min
completed: 2026-04-21
---

# Phase 2 Plan 03: React App Entry Point, Router, and AppShell Layout

**React entry point with dark-mode-first init, TanStack Query client, React Router v6 with two nested routes, and AppShell page frame using UI-SPEC copy and shadcn tokens**

## Performance

- **Duration:** 13 min
- **Started:** 2026-04-21T12:43:41Z
- **Completed:** 2026-04-21T12:56:22Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- main.tsx rewrites the scaffolded stub with dark mode init (before React mount), Inter font import, QueryClient (staleTime 5min, retry 0), and RouterProvider as root
- router.tsx establishes the two-route contract: / → CatalogPage, /apps/:name → AppDetailPage, both nested under AppShell via Outlet
- AppShell.tsx delivers the persistent page frame with exact UI-SPEC copywriting ("App Catalog", "Browse and install self-hosted apps"), max-w-screen-xl container, and shadcn Separator
- CatalogPage and AppDetailPage stubs created so TypeScript imports in router.tsx resolve now; Plan 05 replaces them with full implementations

## Task Commits

1. **Task 1: Write main.tsx and router.tsx (with page stubs)** - `b05ac6d` (feat)
2. **Task 2: Write AppShell layout component** - `b92d087` (feat)

## Files Created/Modified

- `ui/packages/client/src/main.tsx` — Entry point: dark mode init, Inter font, QueryClient, RouterProvider
- `ui/packages/client/src/router.tsx` — createBrowserRouter with / and /apps/:name routes under AppShell
- `ui/packages/client/src/components/AppShell.tsx` — Page frame with header, Separator, Outlet; max-w-screen-xl
- `ui/packages/client/src/pages/CatalogPage.tsx` — Stub (intentional; replaced by Plan 05)
- `ui/packages/client/src/pages/AppDetailPage.tsx` — Stub (intentional; replaced by Plan 05)

## Decisions Made

- Dark mode class added to `<html>` before `ReactDOM.createRoot` to prevent flash of unstyled content — order matters
- QueryClient configured with `retry: 0` because the UI spec defines an explicit Retry button (Plan 05 wires it); automatic retries would confuse that UX
- Outlet pattern chosen over per-route shell imports — one AppShell instance across all navigations, no re-mount on route change

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

| File | Line | Reason |
|------|------|--------|
| `ui/packages/client/src/pages/CatalogPage.tsx` | 2 | Intentional per plan — Plan 05 replaces with full implementation |
| `ui/packages/client/src/pages/AppDetailPage.tsx` | 2 | Intentional per plan — Plan 05 replaces with full implementation |

These stubs exist solely so TypeScript can resolve imports in router.tsx. They do not render any meaningful UI and are expected to be replaced before this plan's goal is visible to the user.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- App shell and routing skeleton ready for Plan 04 (shared UI components: AppCard, AppCardSkeleton, ErrorBlock) and Plan 05 (CatalogPage and AppDetailPage implementations)
- Page stubs must be replaced by Plan 05 before the UI is functional
- No blockers

---
*Phase: 02-catalog-ui*
*Completed: 2026-04-21*
