# Roadmap: LibrePod Marketplace UI

## Overview

Build a web-based marketplace UI that lets non-technical users browse, install, and manage self-hosted apps on their LibrePod cluster. The build follows a read-before-write strategy: catalog API first, then catalog UI, then reading installed state from Gogs, then writing install/uninstall operations, and finally containerizing and deploying into the cluster. Each phase delivers a verifiable capability that the next phase depends on.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Backend Foundation + Catalog API** - Express server serving app catalog data from catalog.yaml with system app filtering
- [x] **Phase 2: Catalog UI** - React SPA with browsable app grid, detail pages, and loading states *(completed 2026-04-21)*
- [ ] **Phase 3: Installed Apps + Live Status** - Gogs integration for reading installed state, K8s health queries, and My Apps view
- [ ] **Phase 4: Install & Uninstall** - One-click install/uninstall with Git write operations, serialized queue, and error feedback
- [ ] **Phase 5: Containerization & Deployment** - Dockerfile, K8s manifests, and integration into bootstrap system apps

## Phase Details

### Phase 1: Backend Foundation + Catalog API
**Goal**: A running NestJS API serves the app catalog from catalog.yaml, filtering out system/infrastructure apps
**Depends on**: Nothing (first phase)
**Requirements**: BACK-01, CAT-04
**Success Criteria** (what must be TRUE):
  1. GET /api/apps returns a JSON list of user-facing apps parsed from catalog.yaml
  2. GET /api/apps/:name returns full detail for a single app (description, version, icon, category)
  3. Infrastructure/system apps do not appear in any API response
  4. GET /api/health returns a successful response (liveness probe ready)
**Plans**: 3 plans

Plans:
- [x] 01-01-PLAN.md — npm workspaces scaffold, dependency install, vitest configs, test fixtures, failing specs (Wave 1)
- [x] 01-02-PLAN.md — CatalogService: YAML loading, Infrastructure filtering, fs.watch hot-reload (Wave 2)
- [x] 01-03-PLAN.md — Controllers, modules, AppModule, main.ts bootstrap — all tests GREEN (Wave 3)

### Phase 2: Catalog UI
**Goal**: Users can browse the app catalog and view app details through a React SPA
**Depends on**: Phase 1
**Requirements**: CAT-01, CAT-02, CAT-03, STAT-02
**Success Criteria** (what must be TRUE):
  1. User sees a card grid of all available apps showing icon, name, description, and category label
  2. User can click an app card to view a detail page with full description, version, icon, and category
  3. UI shows skeleton/spinner loading states while API data is being fetched
  4. User can navigate between catalog and detail pages using browser back/forward
**Plans**: 6 plans
**UI hint**: yes

Plans:
- [x] 02-01-PLAN.md — Vite scaffold: package.json deps, tsconfig trio, vite.config.ts, vitest.config.ts, index.html, shadcn init + 5 components (Wave 1)
- [x] 02-02-PLAN.md — Test scaffold: vitest setup.ts + 5 failing test stubs covering all requirements (Wave 2, parallel)
- [x] 02-03-PLAN.md — App shell: main.tsx entry point, router.tsx with 2 routes, AppShell layout with Outlet (Wave 2, parallel)
- [x] 02-04-PLAN.md — Shared components: AppIcon, AppCard, AppCardSkeleton, ErrorBlock, EmptyState (Wave 3, parallel)
- [x] 02-05-PLAN.md — Page components: CatalogPage (auto-fill grid + all states), AppDetailPage (full detail view) (Wave 3, parallel)
- [x] 02-06-PLAN.md — Test integration: all 21 tests pass, TypeScript clean, workspace scripts wired (Wave 4)

### Phase 3: Installed Apps + Live Status
**Goal**: Users can see which apps are installed and their live health status
**Depends on**: Phase 2
**Requirements**: BACK-02, BACK-03, INST-03, STAT-01
**Success Criteria** (what must be TRUE):
  1. GET /api/installed returns the list of apps currently in the Gogs user-apps repo
  2. Each app displays a status indicator reflecting its actual state (not installed / installing / running / error)
  3. User can view a "My Apps" page showing all currently installed apps with their live status
  4. App detail page shows the current install status and health of the app
**Plans**: 4 plans
**UI hint**: yes

Plans:
- [ ] 03-01-PLAN.md — Server test scaffolds: gogs.service.spec.ts, flux-status.service.spec.ts, installed.service.spec.ts, e2e extension (Wave 1, parallel)
- [ ] 03-02-PLAN.md — Client test scaffolds: StatusBadge.test.tsx, MyAppsPage.test.tsx (Wave 1, parallel)
- [ ] 03-03-PLAN.md — Backend implementation: InstalledModule (GogsService + FluxStatusService + InstalledService + InstalledController), types, module wiring, all server tests GREEN (Wave 2)
- [ ] 03-04-PLAN.md — Frontend implementation: StatusBadge, AppCard overlay, AppShell nav bar, MyAppsPage, router, all client tests GREEN (Wave 3)

### Phase 4: Install & Uninstall
**Goal**: Users can install and uninstall apps with one click, with the backend handling all Git operations safely
**Depends on**: Phase 3
**Requirements**: INST-01, INST-02, BACK-04, STAT-03
**Success Criteria** (what must be TRUE):
  1. User can click "Install" on an app and the backend commits the correct manifests to the Gogs user-apps repo
  2. User can click "Uninstall" on an installed app, confirms via dialog, and the backend removes manifests from Gogs
  3. Two simultaneous install/uninstall requests do not cause Git conflicts (serialized writes)
  4. Failed operations display a toast notification with a meaningful error message
  5. After install, the app appears in "My Apps" and transitions through installing to running status
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] 04-01: TBD

### Phase 5: Containerization & Deployment
**Goal**: The marketplace UI is packaged and deployed as a system app in the LibrePod cluster bootstrap
**Depends on**: Phase 4
**Requirements**: DEPL-01, DEPL-02, DEPL-03
**Success Criteria** (what must be TRUE):
  1. A single Docker container serves both the React SPA (static files) and the Express API
  2. The marketplace-ui deploys as part of the bootstrap system apps via FluxCD
  3. The UI is accessible without authentication from within the local cluster network
  4. The marketplace-ui starts successfully on a fresh cluster bootstrap alongside other system apps
**Plans**: TBD

Plans:
- [ ] 05-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Backend Foundation + Catalog API | 3/3 | Complete | 2026-04-20 |
| 2. Catalog UI | 6/6 | Complete | 2026-04-21 |
| 3. Installed Apps + Live Status | 0/4 | In Progress | - |
| 4. Install & Uninstall | 0/0 | Not started | - |
| 5. Containerization & Deployment | 0/0 | Not started | - |
