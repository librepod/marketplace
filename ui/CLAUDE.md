# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

This is the **marketplace installer UI/API** (Phase 2 of LibrePod) — a single web app
that lets users browse the app catalog and install/uninstall apps on their cluster with
one click. It is a subdirectory of the `marketplace` git repo (this dir is **not** its own
repo; `git` root is `../`). It does **not** run kubectl against the cluster during installs —
it commits to the on-cluster private Gogs repo and lets FluxCD reconcile.

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
- **`GOGS_TOKEN` is the Gogs user's *password*** (Basic auth during token bootstrap), not a
  bearer token. Seeded creds: `GOGS_USERNAME=flux` / `GOGS_TOKEN=pass@w0rd`
  (from `apps/gogs/components/repo-init/secret.env`).
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
  detected. Fixed (with a regression test in `gogs.service.spec.ts`).
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
"Installed" is defined entirely by the Gogs repo `flux/user-apps` root `kustomization.yaml`'s
`resources:` list (each entry is `apps/<name>`). `GogsService.getInstalledAppNames()` reads
that file; if Gogs is unreachable it returns `[]` (everything shows `not_installed`) — this
**graceful degradation** is intentional and tested.

### Request flow
- `GET /api/apps` → `CatalogService.findAll()` (in-memory, hot-reloaded from `catalog.yaml`)
  → `InstalledService.enrich()` stamps each app with `installedStatus`.
- `GET /api/apps/:name` → same, single app.
- `GET /api/installed` → enriched list filtered to non-`not_installed`.
- `POST /api/apps/:name/install` | `/uninstall` → `InstalledService` (mutex-serialized).
- `GET /api/health` → Terminus liveness (empty checks array).

### Install flow (`InstalledService.install`, behind an `async-mutex`)
1. Validate app exists in catalog and has `templates`.
2. Refuse if already in the installed set.
3. Build a `vars` map: `BASE_DOMAIN` from config + one generated secret per
   `secrets[].generate` (crypto hex).
4. **Write per-app files to Gogs first** (`apps/<name>/{source,release,secret,kustomization}.yaml`,
   rendered via `${VAR}` regex substitution).
5. **Update root `kustomization.yaml` last** — append `apps/<name>` to `resources:`.

Steps 4-before-5 is **"Pitfall 3"** (referenced in code comments): if the root kustomization
references an app dir before the files exist, Flux errors on reconcile. Uninstall is the
mirror: it edits the root first (removes the entry) and does **not** delete per-app files —
Flux pruning garbage-collects the live resources.

### Catalog (`CatalogService`)
Reads `catalog.yaml` (path from `CATALOG_PATH`, default `../../../catalog.yaml` relative to
cwd — i.e. the **`marketplace/` root** when running from `packages/server`). Hot-reloads via
`fs.watch` on the directory with a 300ms debounce. **Filters out `category: Infrastructure`
apps** — those are system apps, not user-installable. The catalog file itself is generated by
CI from `apps/*/metadata.yaml` (do not hand-edit; see parent CLAUDE.md).

### Gogs auth (`GogsService`)
On module init it **bootstraps an API token**: POSTs to `/api/v1/users/<user>/tokens` with
HTTP Basic auth (username + password), stores the returned `sha1`, then uses
`token <sha1>` for all repo writes. Writes go through the Gogs **contents API** (base64-encoded,
PUT per file). Root-kustomization edits are read-modify-write (fetch `sha`, dump YAML,
re-PUT).

### Flux status (`FluxStatusService`)
Reads Flux CRDs via `@kubernetes/client-node` `CustomObjectsApi`: lists
`kustomizations` (then `helmreleases`) in `flux-system` with label selector
`marketplace.io/app=<name>`, derives status from `Ready`/`Reconciling` conditions
(`running`/`installing`/`error`). Uses in-cluster config when `KUBERNETES_SERVICE_HOST` is set,
else local kubeconfig. Unreachable k8s or not-yet-propagated CRD → `installing`.

### Client data layer
Three TanStack Query keys: `["apps"]` (catalog), `["apps", name]` (detail), `["installed"]`.
Install/uninstall mutations (`useInstallApp`/`useUninstallApp`) invalidate all three on
success. Default `staleTime: 5min`, `retry: 0` (manual retry via UI button). Routes:
`/` (CatalogPage), `/apps/:name` (AppDetailPage), `/my-apps` (MyAppsPage), all under `AppShell`.
Dark mode is forced on mount (`main.tsx`, decision D-02).

## Configuration (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3000` | server listen port |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | comma-separated CORS origins |
| `CATALOG_PATH` | `cwd/../../../catalog.yaml` | default assumes cwd = `packages/server` |
| `GOGS_URL` | `http://gogs.gogs.svc.cluster.local:80` | on-cluster Gogs |
| `GOGS_USERNAME` | (empty) | user whose token is bootstrapped |
| `GOGS_TOKEN` | (empty) | ⚠ used as the **password** for Basic auth during token bootstrap (name is misleading — it is not used as a bearer token) |
| `BASE_DOMAIN` | `libre.pod` | `${BASE_DOMAIN}` substituted into templates |
| `KUBERNETES_SERVICE_HOST` | — | presence switches FluxStatusService to in-cluster config |

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
  and `GOGS_URL` at a dead port so Gogs is "unreachable" — exercising the graceful-degradation
  path. Mirror this when adding e2e tests; don't hit real Gogs/k8s.
- **Commit/PR hygiene** (inherited from parent): never reference concrete device/cluster
  hostnames in commits, PRs, or public docs — use `dev`/`prod`/`staging`.
