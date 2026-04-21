---
phase: 02-catalog-ui
slug: catalog-ui
date: 2026-04-20
---

# Phase 2: Catalog UI — Validation Architecture

## Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.4 |
| Config file | `ui/packages/client/vitest.config.ts` — Wave 0 creates this |
| Quick run command | `npm test --workspace=packages/client` |
| Full suite command | `npm test --workspace=packages/client -- --coverage` |

---

## Sampling Strategy

Tests are unit tests using Vitest + React Testing Library + jsdom. Each requirement maps to one or more test files. Tests are authored in Wave 0 (before implementation) following the TDD approach defined in the phase plans.

**What to test:**
- Component rendering under all data states (loading, error, success, empty)
- Correct data binding (icon, name, description, category badge, version)
- User interactions (card click navigates, retry button calls refetch)
- Skeleton count is exactly 12
- Error block renders with the retry callback

**How to test:**
- Render components with mocked TanStack Query state or mock props
- Assert DOM output via `@testing-library/jest-dom` matchers
- Simulate clicks with `@testing-library/user-event`

---

## Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File |
|--------|----------|-----------|-------------------|------|
| CAT-01 | AppCard renders icon, name, description, category badge | unit | `vitest run src/components/AppCard.test.tsx` | Wave 0 |
| CAT-01 | CatalogPage renders 12 skeleton cards while loading | unit | `vitest run src/pages/CatalogPage.test.tsx` | Wave 0 |
| CAT-01 | CatalogPage renders cards when data loads | unit | `vitest run src/pages/CatalogPage.test.tsx` | Wave 0 |
| CAT-02 | AppDetailPage renders app details by name | unit | `vitest run src/pages/AppDetailPage.test.tsx` | Wave 0 |
| CAT-02 | AppDetailPage renders not-found state on 404 | unit | `vitest run src/pages/AppDetailPage.test.tsx` | Wave 0 |
| CAT-03 | Badge shows correct category text | unit | `vitest run src/components/AppCard.test.tsx` | Wave 0 |
| STAT-02 | Skeleton grid renders exactly 12 cards | unit | `vitest run src/components/AppCardSkeleton.test.tsx` | Wave 0 |
| STAT-02 | ErrorBlock renders with retry callback | unit | `vitest run src/components/ErrorBlock.test.tsx` | Wave 0 |

---

## Acceptance Thresholds

| Gate | Condition | Command |
|------|-----------|---------|
| Per task commit | All tests pass | `npm test --workspace=packages/client -- --run` |
| Per wave merge | All tests pass + coverage generated | `npm test --workspace=packages/client -- --run --coverage` |
| Phase gate | Full suite green | Required before `/gsd-verify-work` |

All thresholds are binary: either the full suite passes or the phase is not complete. No partial coverage targets are set for this phase — every listed test file must exist and pass.

---

## Wave 0 Gaps (Test Scaffolds to Create)

The following test files do not exist yet and must be created in Wave 0 before implementation tasks run:

- [ ] `ui/packages/client/vitest.config.ts` — Vitest config with jsdom environment
- [ ] `ui/packages/client/src/test/setup.ts` — `@testing-library/jest-dom` import
- [ ] `ui/packages/client/src/components/AppCard.test.tsx` — covers CAT-01, CAT-03
- [ ] `ui/packages/client/src/components/AppCardSkeleton.test.tsx` — covers STAT-02
- [ ] `ui/packages/client/src/components/ErrorBlock.test.tsx` — covers STAT-02
- [ ] `ui/packages/client/src/pages/CatalogPage.test.tsx` — covers CAT-01, STAT-02
- [ ] `ui/packages/client/src/pages/AppDetailPage.test.tsx` — covers CAT-02

---

## Dimension Mapping

| Dimension | Passes When |
|-----------|-------------|
| CAT-01 (app card grid) | AppCard renders all four fields (icon img or fallback, name, truncated description, badge); CatalogPage renders AppCard for each API response item |
| CAT-02 (app detail page) | AppDetailPage renders icon, name, version, category badge, full description, source URL link, and disabled install button; 404 response renders not-found state |
| CAT-03 (category labels) | Badge component inside AppCard contains the app's category string |
| STAT-02 (loading/error states) | SkeletonGrid renders exactly 12 AppCardSkeleton elements while `isPending` is true; ErrorBlock renders the retry button and triggers refetch on click |
