# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

This is the **marketplace installer UI/API** (Phase 2 of LibrePod) — a single web app
that lets users browse the app catalog and install/uninstall apps on their cluster with
one click. It is a subdirectory of the `marketplace` git repo (this dir is **not** its own
repo; `git` root is `../`). It does **not** run kubectl against the cluster during installs —
it commits to the app-store git repo (`flux/user-apps`, hosted by the on-cluster Gogs by
default) and lets FluxCD reconcile.

Read the parent `marketplace/CLAUDE.md` for cluster/GitOps conventions. The authoritative
design spec is `../docs/marketplace-for-self-hosted-apps-design.md` §5 — **but the code
diverges from it in several places (see "Spec vs. implementation" below); code is truth.**

## Monorepo Layout

npm workspaces, three packages:

- **`packages/server`** (`@librepod/server`) — NestJS 11 API (CommonJS, SWC builder). Also
  serves the built client as static files in production.
- **`packages/client`** (`@librepod/client`) — React 19 + Vite SPA (ESM). Tailwind v4,
  shadcn-style UI (`@base-ui/react`), TanStack Query, react-router.
- **`packages/shared`** (`@librepod/shared`) — **type-only package.** `"main": "src/types.ts"`
  is consumed as raw TypeScript source by both packages (works because it exports only
  `interface`/`type`, erased at compile time). No build step; edit `src/types.ts` directly.

The workspace root `package.json` only holds shared deps + workspace-script shims. All real
scripts live in each package's own `package.json`.

## Commands

Run from `ui/` (the workspace root):

```bash
npm install                 # installs all three workspaces

# Dev — run BOTH for full-stack HMR:
npm run dev                 # server (NestJS watch) on :3000
npm run dev:client          # client (Vite) on :5173, proxies /api → :3000

# Build
npm run build:client        # Vite build → packages/client/dist  (do this FIRST)
npm run build               # nest build → packages/server/dist
# (Dockerfile order is build:client then build)

# Test
npm test                    # server unit tests (vitest run, src/**/*.spec.ts)
npm run test:e2e            # server e2e (vitest run --config vitest.e2e-config.ts, test/**/*.e2e-spec.ts)
npm run test:client         # client tests (vitest run, jsdom)
npm run test:e2e:ui         # browser e2e (Playwright, Tier 1) — see "E2E" section below

# Single test — pass a path filter as a positional arg to the workspace's vitest:
npm test --workspace=packages/server -- src/catalog/catalog.service.spec.ts
npm run test --workspace=packages/client -- src/components/AppCard.test.tsx

# Lint/format (server only — client has eslint config but no lint script)
npm run lint --workspace=packages/server     # eslint --fix
npm run format --workspace=packages/server   # prettier --write
```

Server unit vs e2e are split by **separate vitest config files** (`vitest.config.ts` includes
`src/**/*.spec.ts`; `vitest.e2e-config.ts` includes `test/**/*.e2e-spec.ts`). Both use
`unplugin-swc` because Nest decorators need SWC. There is no standalone `tsc --noEmit`
typecheck script — `nest build` is the compile gate.

## E2E (browser, Playwright — Tier 1)

Browser-driven e2e lives in `packages/e2e`. It builds the client+server, brings up a **real
`gogs/gogs` container** seeded from the repo's `gogs-init.zip` backup-restore (the same
mechanism as `apps/gogs/components/repo-init`), and drives the prod-like Nest server with
Chromium. No cluster, no real GHCR — fully hermetic.

```bash
npm run test:e2e:ui                                       # full run (build → Gogs → Playwright → teardown)
npm run test:e2e:ui -- tests/app-level/catalog.spec.ts    # one spec file
```

Conventions and gotchas:

- **Hermetic Gogs:** the orchestrator (`packages/e2e/support/run-tier1.sh`) does
  `compose up → readiness check → playwright → compose down -v`, so each run starts from a
  clean seed. The catalog is `packages/e2e/fixtures/catalog.fixture.yaml` (3 user-facing apps
  + 3 Infrastructure; `vaultwarden`/`litellm` have install `templates`).
- **Tier 1 drives the real production credential path.** `tier1.config.ts` sets
  `USER_APPS_GIT_URL=http://127.0.0.1:43000/flux/user-apps.git` +
  `USER_APPS_GIT_USERNAME=flux` / `USER_APPS_GIT_PASSWORD=pass@w0rd` — the same `http`
  transport the cluster uses, since #182. The URL override is required because Tier 1 has
  no cluster to discover the GitRepository from. One gap it CANNOT cover: its port (43000)
  is non-default, so the `http://…:80` credential-entry bug is invisible here — that guard
  lives in `git-remote.service.spec.ts`.
- **Tier 1 starts in the PRE-#182 repo layout on purpose** (root `kustomization.yaml` +
  an orphaned `apps/orphan-probe/`), so the boot-time migration is covered end-to-end by
  `tests/app-level/repo-layout.spec.ts`.
- **Read repo contents over git, not the Gogs tree API.** This release ignores
  `?recursive=1` on `git/trees/<ref>` and returns only the top level, so path assertions
  built on it are silently vacuous.
- **`KUBECONFIG` is pinned to a closed-port fixture** (`packages/e2e/support/kubeconfig.closed.yaml`)
  in `projects/tier1.config.ts`. With no cluster, `FluxStatusService.loadFromDefault()` would
  otherwise read the host's `~/.kube/config` and query a real cluster; the closed port makes
  the k8s call `ECONNREFUSE` → `getStatusFor` degrades to `installing` deterministically. This
  is **also required for the server to boot on CI**, where there is no `~/.kube/config` at all
  (`loadFromDefault` would throw in `onModuleInit`).
- **Serial execution** (`workers: 1`, `fullyParallel: false`): specs share one Gogs instance,
  so an install in one spec mutates state another reads. Specs that assert a clean slate
  (e.g. `my-apps`, `resilience`) uninstall leftovers first.
- **Port 3100** (not 3000) so the gate doesn't collide with a developer's running server;
  `reuseExistingServer: false` makes Playwright refuse to test a server it didn't start.
- **Selectors target roles/text** (`getByRole`/`getByText`); the only `data-testid` is
  `app-card-skeleton`. Page objects live in `packages/e2e/support/pages`.
- **`/api/apps` and `/api/installed` return bare `CatalogApp[]` arrays**, not `{ apps: [...] }`
  (the client defends with `json.apps ?? json`).
- **CI:** `.github/workflows/ui-e2e.yaml` runs Tier 1 on every PR touching `ui/**`. Roll it
  out non-required first, then flip to a required status check once green.
- **Bug found by this suite:** `GogsService.getInstalledAppNames` only stripped a trailing
  slash, leaving the `apps/` prefix from root-kustomization entries — so installs were never
  detected. Both the bug and its service are gone since #182 (the installed set is now
  directory names under `apps/`), but it is why that path has e2e coverage at all.
- **SPA fallback already works:** `@nestjs/serve-static` v5 serves `index.html` for unmatched
  non-API routes, so deep-link reload does not 404 and no `connect-history-api-fallback` is
  needed.
- **Tier 2** (k3d cluster, full Flux reconcile → `running`) — see the dedicated section below.

## E2E Tier 2 (browser, in a local k3d cluster — nightly/advisory)

```bash
npm run test:e2e:ui:cluster          # k3d create → Flux bootstrap → port-forward → Playwright → delete
npm run test:e2e:ui:cluster -- tests/cluster-level/cluster-smoke.spec.ts   # one spec
```

- Boots a dedicated `librepod-k3d-e2e` cluster (`packages/e2e/support/k3d-e2e.config.yaml`) that
  syncs `clusters/librepod-k3d` via Flux — the full system-apps chain + the published
  `marketplace-ui` image. Reached via `kubectl port-forward` (HTTP, no ingress).
- Asserts the **full GitOps lifecycle** Tier 1 can't: install → Flux reconcile → `running`; the
  Uninstall `AlertDialog`; the "Open {app}" link. These need `running`/`error` status, reachable
  only with a cluster.
- Tests the **published** image (`:latest`), not a source build — Tier 2 runs on master/nightly
  (never PRs), so `:latest` IS master's code.
- Advisory CI: `.github/workflows/ui-e2e-cluster.yaml` (nightly + push to master + dispatch).
  **Never** a required check.
- Needs `k3d`, `flux`, `kubectl`, `curl` on PATH (`shell.nix` provides them; CI installs them).
- Override the app used for the `running` assertion with `LIBREPOD_E2E_APP=<name>`.

Gotchas / deviations from the original plan:

- **API shape:** specs hit the same bare-`CatalogApp[]` APIs as Tier 1 — `/api/apps` is an array
  (not `{apps:[...]}`), and `/api/apps/:name` returns a single object (read `.installedStatus`
  directly, not `body.apps[0].installedStatus`). `/api/config` returns `{ baseDomain }`.
- **Serial execution:** `tier2.config.ts` sets `workers:1, fullyParallel:false` — the reconcile
  tests share one cluster (the install test creates the `running` app the Open/Uninstall tests
  act on), mirroring Tier 1's reason for serializing on a shared Gogs.
- **k3d config `files.source` paths are relative to the CONFIG FILE** (`…/e2e/support/`), not the
  CWD (verified on k3d v5.9.0) — hence `../../../../clusters/...` in `k3d-e2e.config.yaml`. The
  repo-root `k3d-config.yaml` uses bare `clusters/...` only because it sits at the repo root.
- **The orchestrator isolates `KUBECONFIG`** (`run-tier2.sh`) to a temp file and asserts the
  active context is `librepod-k3d-e2e` before any kubectl call — so a failed `k3d create` can
  never fall through to whatever real cluster was current and mutate it.
- **Port-forward on 3101** (not 3000) to avoid colliding with a developer's running server.
- **`confirmUninstall()` self-opens the dialog** (trigger `.first()` → confirm action `.nth(1)`);
  the reconcile spec must NOT pre-open before calling it, or the trigger toggle closes the dialog.

✅ **Previously blocked, now FIXED:** the k3d bootstrap used to never reach `marketplace-ui`
because flux-operator ≤0.48.0 couldn't assemble the Flux CRDs — `FluxInstance/flux` reported
`build failed: …eventSources/items/properties/kind/enum/-`, an in-image operator/CRD patch skew,
so no Flux controllers started. Bumping
`clusters/librepod-k3d/bootstrap/{flux-operator,flux-instance}.yaml` to **0.57.0** fixes it
(operator + instance move in lockstep as a matched pair). Verified by an isolated k3d boot: the
CRD server-side-apply completes (all notification CRDs created, Flux `v2.9.3`) and all four
controllers come up `Running`. The focused test never reached a literal `Ready=True` only because
it deliberately omitted `cosign-pub`; the real `k3d-config.yaml` supplies it. Tracked in
[#48](https://github.com/librepod/marketplace/issues/48). The Tier 2 suite itself is complete and
statically validated (configs valid, orchestrator `bash -n` clean, Playwright lists all 4 tests,
selectors verified against the client source).

## Architecture

### One container, server serves client
`AppModule` mounts `@nestjs/serve-static` pointing at `packages/client/dist` with
`exclude: ['/api/{*path}']`, and `main.ts` sets global prefix `api`. So in production the
Nest server (port 3000) serves both the SPA and the API; the client calls relative `/api/*`.
In dev the two run separately and Vite proxies `/api` to `:3000`.

### No database — Git is the source of truth
"Installed" means **`apps/<name>/` exists in the app-store repo's tree**. There is no root
`kustomization.yaml` any more (#182): Flux auto-generates one from the whole tree, so an
app's presence IS its declaration. `UserAppsRepoService.listInstalledApps()` reads the
directory names out of a shallow git working copy refreshed on a 10s freshness window.

Degradation is layered, and the distinction matters:
- **git unreachable, working copy present** → the cached list is served **stale but true**.
  Reporting `not_installed` for a running app would be worse than reporting a slightly old
  answer.
- **cold start, no working copy** → `[]`, i.e. everything reads `not_installed`.
- **working copy unreadable by git** (not merely a dead remote) → discarded and re-cloned,
  so a corrupt tree cannot wedge every future read.
- **any write** with an unreachable remote → throws. A write must never silently apply to a
  stale tree.

### Request flow
- `GET /api/apps` → `CatalogService.findAll()` (in-memory, hot-reloaded from `catalog.yaml`)
  → `InstalledService.enrich()` stamps each app with `installedStatus`.
- `GET /api/apps/:name` → same, single app.
- `GET /api/installed` → enriched list filtered to non-`not_installed`.
- `GET /api/system-apps` → `InstalledService.getSystemApps()` → enriched apps where `system === true` (the read-only Platform panel on `/`).
- `POST /api/apps/:name/install` | `/uninstall` → `InstalledService` (mutex-serialized).
- `GET /api/health` → Terminus liveness (empty checks array).

### Install flow (`InstalledService.install`, behind an `async-mutex`)
1. Validate app exists in catalog and has `templates`.
2. Refuse if already in the installed set.
3. Build a `vars` map: `BASE_DOMAIN` from config + one generated secret per
   `secrets[].generate` (crypto hex).
4. Render `apps/<name>/{source,release,secret,kustomization}.yaml` (via `${VAR}` regex
   substitution) and write them all as **one commit** (`UserAppsRepoService.writeApp`).

**"Pitfall 3" is retired.** It was a write-ORDERING rule — app files before the root
`kustomization.yaml`, so Flux never saw an entry naming a directory that did not exist yet.
There is no root file and no second write, so atomicity comes from the commit instead.

Uninstall is the true mirror now: `removeApp` **deletes the whole `apps/<name>/`
directory** in one commit. Pre-#182 it only edited the root file and left the files behind,
because the provider's contents API has no DELETE route.

### Catalog (`CatalogService`)
Reads `catalog.yaml` (path from `CATALOG_PATH`, default `../../../catalog.yaml` relative to
cwd — i.e. the **`marketplace/` root** when running from `packages/server`). Hot-reloads via
`fs.watch` on the directory with a 300ms debounce. **Filters out `category: Infrastructure`
apps** — those are system apps, not user-installable. The catalog file itself is generated by
CI from `apps/*/metadata.yaml` (do not hand-edit; see parent CLAUDE.md).

### App-store repo (`UserAppsRepoService`)
Three units replaced `GogsService` (#182), split by what they know:

- **`GitClient`** — mechanical git in a working directory (`clone`/`fetchAndReset`/`stageAll`/
  `removePath`/`commit`/`push`). The only place that spawns `git`, so the safety rules live
  there: `execFile` not `exec`, `GIT_TERMINAL_PROMPT=0`, and `GIT_CONFIG_NOSYSTEM` +
  `GIT_CONFIG_GLOBAL=/dev/null` so no ambient config can shadow the per-invocation one.
  Knows nothing about apps or Kubernetes.
- **`GitRemoteService`** — *where* the repo is and *how* to authenticate. The URL and branch
  are **discovered from `GitRepository/user-apps-source`**, the same object Flux reads, so
  the installer can never commit to a repo Flux is not reconciling; repointing that object
  at GitHub/GitLab needs no code change (but does need a pod restart — the resolved remote
  is cached for the process lifetime). The GitRepository's `secretRef` is deliberately NOT
  read: its name is dynamic, so RBAC could not scope it and the server would need
  `get secrets` across all of `flux-system`. The credential is **mounted** instead, as
  `username`/`password` files, and written to a `0600` `.git-credentials` consumed via
  `credential.helper=store` — never embedded in the remote URL, where it would leak into
  `git remote -v`, the reflog and error messages.
- **`UserAppsRepoService`** — app-level semantics (`listInstalledApps`/`writeApp`/`removeApp`)
  plus the one-time layout migration.

**git is not optional.** This Gogs release has **no DELETE route on its contents API**
(live-probed: all three request shapes return an unrouted HTML 404), so uninstall could
never delete an app's files over REST. git is also what makes the repo pluggable.

**Transport: `http(s)` only.** An `ssh://` remote is rejected at resolution with a named
error telling you to repoint the GitRepository — it is not a second supported path. The
reason it is a rejection rather than a fallback: Tier 1 has no port 22, so shipping ssh
would mean shipping the one transport no fast test covers. Tracked in issue #182.

**Layout migration** (`migrateLayout`, run from `onModuleInit`): deletes orphaned
`apps/<name>/` directories — present in the tree but absent from the old root file's
allow-list, so not deployed today and would spring to life once it is removed — and then
the root `kustomization.yaml` itself, in that order, as one commit. It **must not throw**
out of `onModuleInit`: a one-shot bootstrap that fails on a cold cluster leaves the
container broken for its whole lifetime (the #176 failure mode). It logs and re-attempts on
the next write.

### Flux status (`FluxStatusService`)
Reads Flux CRDs via `@kubernetes/client-node` `CustomObjectsApi`: lists
`kustomizations` (then `helmreleases`) in `flux-system` with label selector
`marketplace.io/app=<name>`, derives status from `Ready`/`Reconciling` conditions
(`running`/`installing`/`error`). Uses in-cluster config when `KUBERNETES_SERVICE_HOST` is set,
else local kubeconfig. Unreachable k8s or not-yet-propagated CRD → `installing`.

### System apps (`SystemAppsService`)
A "system app" is a platform component managed by the cluster's `system-apps`
Flux Kustomization (traefik, casdoor, gogs, frp-operator, …), not user-installable.
Membership is derived at runtime per cluster (flavour-correct): list flux-system
`OCIRepository`s carrying the `kustomize.toolkit.fluxcd.io/name=system-apps`
parent label, parse each `spec.url` (`oci://…/apps/<catalog-name>`) for the
catalog app name, and keep the paired Flux object name for status. Cached ~30s;
on k8s-unreachable degrades to the last-known set (empty on cold start).
`getSystemApps()` returns `Map<catalogName, fluxKustomizationName>` (note the
name can differ, e.g. `nfs-provisioner` → `storage`).

In `enrich`, system classification wins over the app-store "installed?" check, and
status is derived via `FluxStatusService.getStatusFor(name, { systemKustomization })`
(queries the Kustomization by name, not the `marketplace.io/app` label). This is
why a system app like frp-operator reads `running` instead of a forever-`installing`
badge even when it also has a stale directory in the user-apps repo.

`CatalogApp.system` is a runtime-enriched boolean (not in `catalog.yaml`).
`/api/apps` excludes system apps; `/api/system-apps` lists them; install/uninstall
of a system app returns 409. The `SYSTEM_APPS_OVERRIDE` env (JSON
`[{name, kustomization}]`) is a test seam used by Tier 1 e2e.

### Client data layer
Three TanStack Query keys: `["apps"]` (catalog), `["apps", name]` (detail), `["installed"]`.
Install/uninstall mutations (`useInstallApp`/`useUninstallApp`) invalidate all three on
success. Default `staleTime: 5min`, `retry: 0` (manual retry via UI button). Routes:
`/` (MyAppsPage — the installed-apps control plane, the daily home), `/catalog`
(CatalogPage — browse/install), `/apps/:name` (AppDetailPage — status/uninstall),
`/my-apps` (legacy alias → redirects to `/`), all under `AppShell`.
Dark mode is forced on mount (`main.tsx`, decision D-02).

**My Apps control plane** (`MyAppsPage`): the home is a launcher, not a browse grid.
Each `LaunchTile` body is a live link opening the running app at
`https://<name>.<baseDomain>` (via `appUrl()` in `lib/utils.ts`) in a new tab; a
corner "Manage" affordance routes to the detail page (the two are sibling anchors,
never nested). Apps not yet `running` route their body to detail instead of a dead
host. Above the grid, a device-status strip reports running/installing/error counts
+ base domain; below it, `ControlsPanel` shows roadmap placeholders (Backups /
Restart / Users) marked with `SoonTag`. All status dots read from the single
`STATUS_DOT` map exported by `StatusBadge.tsx`.

## Configuration (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3000` | server listen port |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | comma-separated CORS origins |
| `CATALOG_PATH` | `cwd/../../../catalog.yaml` | default assumes cwd = `packages/server` |
| `USER_APPS_GIT_URL` | (empty) | **test seam only.** Normally the remote is discovered from `GitRepository/user-apps-source`; setting this bypasses discovery (Tier 1 has no cluster). Do not set it in cluster manifests — the installer would commit to a repo Flux may not be reading. |
| `USER_APPS_GIT_BRANCH` | `master` | only consulted alongside `USER_APPS_GIT_URL`; otherwise from `spec.ref.branch` |
| `USER_APPS_GIT_USERNAME` | (empty) | overrides the `username` file in the credentials dir |
| `USER_APPS_GIT_PASSWORD` | (empty) | overrides the `password` file in the credentials dir |
| `USER_APPS_GIT_CREDENTIALS_DIR` | `/etc/user-apps-git` | mounted Secret with `username`/`password` files (Reflector-populated) |
| `USER_APPS_WORK_DIR` | `/var/lib/user-apps` | working copy (`repo/`) + the generated `0600 .git-credentials`; disposable emptyDir |
| `BASE_DOMAIN` | `libre.pod` | `${BASE_DOMAIN}` substituted into templates |
| `KUBERNETES_SERVICE_HOST` | — | presence switches FluxStatusService to in-cluster config |

The transport is **`http(s)` only** — an `ssh://` remote is rejected at resolution rather
than silently attempted, so don't debug it as a working alternative.

There is no `.env` file committed; `ConfigModule` reads `process.env` directly.

## Conventions & gotchas

- **Spec vs. implementation.** The design doc §5 describes the installer *generating* full
  Flux manifests and REST endpoints like `GET /api/catalog` / `POST /api/apps/install`. The
  real code *renders templates baked into `catalog.yaml`* and uses `GET /api/apps` /
  `POST /api/apps/:name/install`. When the two disagree, follow the code; update the doc if
  something is now intentional.
- **Templates come from the catalog, not generated.** `app.templates.{source,release,secret,kustomization}`
  in `catalog.yaml` are the literal file bodies; the installer only does `${VAR}` substitution.
  To change an app's install shape, change its `metadata.yaml` `templates:` (upstream of the
  catalog), not this code.
- **`@librepod/shared` has no build.** It's raw `.ts`; both packages resolve it via tsconfig
  `paths` (server) / Vite (client). Adding runtime (non-type) code there will break the server
  build.
- **Nest circular DI.** `CatalogController` injects `InstalledService`, while `InstalledModule`
  imports `CatalogModule` — so the import is wrapped in `forwardRef(() => CatalogModule)`.
  Preserve that `forwardRef` if you rewire these two modules or add a cross-dependency, or Nest
  fails to bootstrap with a circular-dependency error.
- **Ticket IDs in comments** (e.g. `D-02`, `BACK-02`, `STAT-01`, `INST-03`, "Pitfall 3") trace
  to the design doc / a decisions log, not to files in this dir.
- **Testing pattern:** e2e tests point `CATALOG_PATH` at `test/fixtures/catalog.fixture.yaml`
  and `USER_APPS_GIT_URL` at a dead port so the app-store repo is "unreachable" — exercising
  the graceful-degradation path. Mirror this when adding e2e tests; don't hit real Gogs/k8s.
- **Commit/PR hygiene** (inherited from parent): never reference concrete device/cluster
  hostnames in commits, PRs, or public docs — use `dev`/`prod`/`staging`.
