# Marketplace UI — End-to-End Test Suite (Playwright, Hybrid Tiered)

- **Date:** 2026-08-01
- **Status:** Design (pending implementation plan)
- **Scope:** `ui/` (the marketplace installer UI/API) + a local k3d cluster for deployment-level tests
- **Branch:** `cyxou/Add-E2E-tests`

> **⚠ Partly superseded (2026-08-22, issue #182) — historical design record.** The Gogs
> REST layer this document assumes is gone: `GogsService`, the
> `GOGS_URL`/`GOGS_USERNAME`/`GOGS_TOKEN` env triple, and the root `kustomization.yaml`
> read-modify-write were all deleted. Installs are now one plain git commit via
> `UserAppsRepoService`, and "installed" means `apps/<name>/` exists in the repo tree.
> The tiering, Playwright architecture and the C2/C4 constraints still hold. For current
> behaviour see `ui/CLAUDE.md` — "No database — Git is the source of truth" and "App-store
> repo (`UserAppsRepoService`)" — plus `docs/DECISIONS_LOG.md` rows 7 and 8.

## 1. Problem

The marketplace UI has **no browser-driven end-to-end tests**. Its only test
infrastructure is vitest: server unit tests (`src/**/*.spec.ts`), server API-level
"e2e" (`test/**/*.e2e-spec.ts`, supertest against the NestJS app with a dead
`GOGS_URL`), and client component tests (`*.test.tsx` in jsdom with `fetch` mocked).

None of these exercise the **real SPA in a real browser** against the real NestJS
server, and none validate the **deployment path** (Flux reconciliation, the shipped
container image, the GitOps install lifecycle). CI runs **no tests at all** today —
`publish-marketplace-ui.yaml` only builds and pushes the image.

## 2. Goals

1. **Browser e2e for the SPA** — drive the real UI (Chromium via Playwright) through
   catalog browsing, app detail, install/uninstall, and "My Apps", asserting correct
   rendering, routing, and request behavior.
2. **Hermetic + fast per-PR feedback** — a blocking regression gate on every PR
   touching `ui/**`, runnable locally with one command, deterministic and fast.
3. **Deployment-level realism (off the critical path)** — a second tier that boots the
   real marketplace in a local k3d cluster, asserting the full GitOps lifecycle
   (install → Flux reconciliation → `running`; uninstall → pruning), which the fast
   tier fundamentally cannot do.
4. **Reuse existing tooling** — align with the established server-e2e pattern
   (fixture catalog + stubbed Gogs), the existing `k3d-config.yaml` +
   `clusters/librepod-k3d/` bootstrap, and the `verify-app` skill's port-forward
   pattern.

## 3. Non-goals

- Visual regression / screenshot diffing.
- Cross-browser coverage beyond Chromium in CI (Firefox/WebKit available locally).
- Performance/load testing.
- Testing the Casdoor SSO controller or any surface outside the marketplace UI SPA.
- A per-PR cluster-based gate (deliberately rejected — see §5.3).
- Testing against the long-lived `dev` cluster (tests must be hermetic/ephemeral).

## 4. Key decisions (and rationale)

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| D1 | **Playwright** (Chromium) | Cypress, Puppeteer, WebDriverIO | Best-in-class DX, built-in `webServer`/artifacts, first-class GH Actions support, modern API. |
| D2 | **Full-vertical hermetic** integration boundary | UI-only with mocked API; full stack incl. real cluster | Real browser + real Nest server + built client catches build/serve/routing regressions that mocked-UI tests cannot. |
| D3 | **Hybrid two-tier** architecture | Gogs-in-Docker only; k3d cluster only | The two approaches test different things (app logic vs deployment). Forcing one trades speed against realism. Two tiers avoid the trade-off. |
| D4 | **Real Gogs**, seeded via the existing `gogs-init.zip` backup-restore | Fake/mock Gogs; dead `GOGS_URL` (degraded-only) | Lets the real `InstalledService` run end-to-end (secret gen, per-app file writes, root-kustomization read-modify-write). Reuses prod's exact seeding — no drift. |
| D5 | **New `packages/e2e` workspace** | Co-locate in `packages/client`; repo-root `e2e/` | Matches the repo's one-concern-per-workspace convention; keeps `ui/` self-contained. |
| D6 | **k3d** (not kind) for Tier 2 | kind | k3d is already in `shell.nix`; existing `k3d-config.yaml` + `clusters/librepod-k3d/` prior art; k3s `HelmChart` auto-deploy has no kind equivalent; ~3× faster boot. |
| D7 | **Blocking per-PR gate (Tier 1) + advisory nightly (Tier 2)** | Advisory-only; local-only | "Automatic" requires CI; Tier 1 is fast/deterministic enough to block; Tier 2 is too slow/flaky for per-PR, so it runs off-critical-path. |

### Critical correctness constraints discovered during research

- **C1 — `GOGS_TOKEN` is a password, not a bearer token.** `GogsService` uses `GOGS_TOKEN`
  as the HTTP Basic-auth *password* during token bootstrap (the name is misleading). The
  seeded Gogs user's **password must equal `GOGS_TOKEN`**; Nest bootstraps its own API
  token at runtime. A wrong seed field → 401 on every install with a misleading error.
  **⚠ No longer applies (#182):** `GogsService` and the `GOGS_TOKEN` env var are gone. The
  credential is a `username`/`password` file pair mounted at `/etc/user-apps-git` and used
  by git over HTTP — no token bootstrap, so this gotcha has no successor.
- **C2 — Without `KUBERNETES_SERVICE_HOST`, an installed app never reaches `running`.**
  `FluxStatusService` reads Flux CRDs via the in-cluster config; with no cluster it
  degrades to `installing` indefinitely. **Tier 1 must therefore assert install-*commit*
  (mutation success + app in `/api/installed` + root kustomization lists `apps/<name>`),
  not a `running` badge.** Proving Flux reconciliation is Tier 2's job.
- **C3 — Gogs seeding in prod is backup-restore, not API.** `apps/gogs/components/repo-init/`
  runs an initContainer that restores an embedded `gogs-init.zip` (provisioning the `flux`
  user, `user-apps` repo, and token). Both tiers reuse this mechanism — Tier 1 by mounting
  the same backup into the compose Gogs container, Tier 2 by letting the existing
  `repo-init` component run in-cluster.
- **C4 — `marketplace-ui`'s ingress/TLS path drags in cert-manager + traefik + step.**
  Reached via `kubectl port-forward` over HTTP (the `verify-app.sh` pattern), the
  *functional* dependency collapses to Flux + Gogs (+repo-init) + Reflector (for the
  `gogs-auth` Secret mirror). Tier 2 uses port-forward, so it needs none of the TLS chain
  to exercise the app — though the full bootstrap (Tier 2's choice) deploys it anyway.

## 5. Architecture

### 5.1 Workspace layout

A fourth npm workspace, `ui/packages/e2e/`, owns the entire e2e concern. One workspace,
two runners, a shared core.

```
ui/packages/e2e/
├── package.json                    # @librepod/e2e; dep: @playwright/test
├── playwright.config.ts            # shared base: reporters, retries, browser, artifacts
├── projects/
│   ├── tier1.config.ts             # app-level (host + Gogs-in-Docker)
│   └── tier2.config.ts             # deployment-level (k3d cluster)
├── support/
│   ├── run-tier1.ts                # orchestrator: build → compose up --wait → seed → playwright → down
│   ├── run-tier2.ts                # k3d create → wait Flux → import UI image → port-forward → playwright → delete
│   ├── gogs-seed.ts                # shared: idempotent gogs-init.zip restore (+ repo/user existence checks)
│   ├── pages/                      # Page Object Model: CatalogPage, AppDetailPage, MyAppsPage, AppShell
│   └── env.ts                      # resolved ports/URLs/creds
├── docker-compose.e2e.yml          # Tier 1: gogs/gogs + volume-mounted gogs-init.zip + restore init
├── fixtures/
│   └── catalog.fixture.yaml        # Tier 1 catalog (2–3 user-installable apps; reuse server fixture shape)
└── tests/
    ├── app-level/                  # Tier 1 (comprehensive); a subset also runs in Tier 2
    └── cluster-level/              # Tier 2 only (reconcile-to-running, pruning)
```

Root `ui/package.json` adds two shim scripts (existing server `test:e2e` is untouched):

```jsonc
"test:e2e:ui":        "npm run test:e2e:ui --workspace=packages/e2e",        // Tier 1
"test:e2e:ui:cluster": "npm run test:e2e:ui:cluster --workspace=packages/e2e" // Tier 2
```

### 5.2 Tier 1 — app-level, per-PR blocking gate

**System under test:** the marketplace app built from source, served prod-like by the
real NestJS server, talking to a real (containerized, seeded) Gogs. No cluster, no Flux,
no `KUBERNETES_SERVICE_HOST`.

**Lifecycle (`support/run-tier1.ts`):**

1. `npm run build:client && npm run build` — Vite → `packages/client/dist`, Nest →
   `packages/server/dist` (identical to the Dockerfile build — tests what ships).
2. `docker compose -f docker-compose.e2e.yml up -d --wait` — Gogs healthy on
   `127.0.0.1:43000`; init step restores `gogs-init.zip` (C3).
3. `gogs-seed.ts` — idempotently ensure the `flux` user, `user-apps` repo, and root
   `kustomization.yaml` (`resources: []`) exist.
4. `playwright test` — Playwright `webServer` launches `node packages/server/dist/main.js`
   with env:
   - `CATALOG_PATH` → `fixtures/catalog.fixture.yaml`
   - `GOGS_URL` → `http://127.0.0.1:43000`
   - `GOGS_USERNAME` / `GOGS_TOKEN` → seeded creds (C1: `GOGS_TOKEN` = the user's *password*)
   - **⚠ Superseded (#182):** those three vars no longer exist. Tier 1 now points the server
     at the Gogs git remote and mounts `username`/`password` files; see `ui/CLAUDE.md`.
   - `BASE_DOMAIN=libre.pod`, `KUBERNETES_SERVICE_HOST` unset
   - `url: http://localhost:3000`, `reuseExistingServer: !process.env.CI`
5. `trap EXIT` → `docker compose down`.

> **Build-vs-serve split:** the build lives in the orchestrator (always fresh); Playwright's
> `webServer` only owns the running process. Hiding the build inside `webServer.command` would
> let local `reuseExistingServer` silently skip rebuilds and test stale code.

**What Tier 1 asserts (and what it cannot):** install/uninstall run through the real
`InstalledService` against real Gogs, so it validates secret generation, per-app file
writes, and the root-kustomization read-modify-write ("Pitfall 3" ordering). It asserts
install-*commit* (mutation success, membership in `/api/installed`, root kustomization
entry). It **cannot** assert `running` (C2) — that gap is Tier 2's purpose.

> **⚠ Superseded (#182):** there is no root `kustomization.yaml` and no read-modify-write.
> Install commits `apps/<name>/` and uninstall deletes that directory, each in one commit;
> `/api/installed` is derived from directory presence in the tree. Read every
> root-kustomization assertion in this document (§5.2, §5.3's prune bullet, §6's
> `install-uninstall.spec.ts` row) as "the app's directory exists / is gone".

### 5.3 Tier 2 — deployment-level, nightly / on-merge / dispatch (advisory)

Off the per-PR critical path, Tier 2 chooses realism over speed and **reuses the existing
bootstrap as-is** (no divergent minimal-subset cluster dir to maintain).

**Lifecycle (`support/run-tier2.ts`):**

1. Fix `k3d-config.yaml`'s stale host volume path (see §8 R2), then
   `k3d cluster create --config ./k3d-config.yaml`.
2. Wait for the Flux bootstrap to reconcile `clusters/librepod-k3d/` (full system-apps
   chain; ~5–10 min — acceptable for a nightly). Poll via `flux get kustomizations` /
   `kubectl wait`.
3. **Source-driven image:** build the marketplace-ui image from the PR's source, tag it to
   match the Deployment's expected image ref, `k3d image import` it into the cluster's
   containerd, then `kubectl rollout restart deployment/marketplace-ui` so the Deployment
   runs the imported image instead of re-pulling from the registry. (Tier 2 tests *this
   PR's* code, not a registry tag. Other system images still pull signed from GHCR via
   cosign — the real supply chain.)
4. `kubectl port-forward svc/marketplace-ui -n marketplace-ui 3000:80` (the `verify-app.sh`
   pattern — HTTP, sidesteps traefik/TLS/step, per C4).
5. `playwright test --config=projects/tier2.config.ts` against `http://localhost:3000`.
6. Teardown: kill port-forward, `k3d cluster delete`.

**What Tier 2 asserts that Tier 1 cannot:**

- Install → poll Flux CRDs (`kustomizations`/`helmreleases` in `flux-system` with label
  `marketplace.io/app=<name>`) → app status transitions to **`running`**.
- Uninstall → Flux **prunes** the live resources (root kustomization entry removed →
  resources garbage-collected).
- Catalog renders against the **real** in-cluster Gogs and the real catalog ConfigMap.

### 5.4 Shared core

- **Page Object Model** (`support/pages/`) — selectors in one place; both tiers reuse.
- **`gogs-seed.ts`** — same idempotent restore logic both tiers call.
- **Playwright config inheritance** — `playwright.config.ts` holds reporters, retries,
  browser, artifact settings; `tier1.config.ts` / `tier2.config.ts` set their own
  `webServer`/`baseURL`/testDir.
- **Flakiness defenses** (Tier 1 is blocking, so this matters most): `retries: 2` on CI /
  `0` local; `trace: 'on-first-retry'`; video + screenshot on failure; generous timeouts
  (server boot 60s, Gogs `--wait`, per-test 20s); idempotent seed; **no fixed `sleep`s** —
  rely on Playwright auto-waiting and `expect` polling against the UI's 3s status poll.

## 6. Test inventory

### Tier 1 — `tests/app-level/` (comprehensive)

| Spec | Covers |
|---|---|
| `catalog.spec.ts` | cards render from fixture; search filters; single-select category chips; `?q`/`?category` URL round-trip; empty-results state; `Infrastructure` apps filtered out |
| `app-detail.spec.ts` | card → `/apps/:name` nav; icon/version/description/status render; unknown-app state; "View project" href; action-button visibility by status |
| `install-uninstall.spec.ts` | install: click → success toast → app appears in `GET /api/installed` (which the server derives by reading the root kustomization, so this transitively proves `apps/<name>` was appended); uninstall: confirm `AlertDialog` → confirm → toast → app no longer in `/api/installed` (optional: a direct Gogs contents-API read of the root kustomization to confirm the entry was removed); install-when-already-installed refused |
| `my-apps.spec.ts` | empty state; installed app appears in grid; "Open {app}" → `https://{name}.libre.pod` |
| `resilience.spec.ts` | catalog renders with install actions despite flux-unreachable; failed-install error toast + retry; **deep-link reload on `/my-apps`** ⚠ (see §7 SPA fallback) |

### Tier 2 — `tests/cluster-level/` + a Tier-1 subset

| Spec | Covers |
|---|---|
| `cluster-smoke.spec.ts` | catalog renders against real in-cluster Gogs + real catalog ConfigMap; install/uninstall UI flows against the live deployment |
| `reconcile-lifecycle.spec.ts` | install → Flux CRD `Ready` → status `running`; uninstall → resources pruned (the lifecycle Tier 1 cannot assert, per C2) |

## 7. Resolved sub-decisions

- **SPA-fallback / deep-link test (⚠):** ship the test. `@nestjs/serve-static` currently
  has no `fallback` configured, so reloading `/my-apps` likely 404s. If the test fails,
  **fix it** in `AppModule` (`serveStaticOptions.fallback`) as part of this work — this is
  exactly the regression the suite exists to catch.
- **Browser matrix:** Chromium-only in CI; `--project=firefox`/`webkit` available locally.
- **Naming:** `test:e2e:ui` (Tier 1), `test:e2e:ui:cluster` (Tier 2); server `test:e2e`
  untouched.
- **Tier 2 cluster scope:** full chain via existing `clusters/librepod-k3d/` (not a
  minimal-subset dir) — realism over speed, since it is not per-PR.
- **Tier 2 image source:** `k3d image import` of a source-built image (registry-free for
  the UI image; tests the PR's own code).

## 8. CI / automation

| Workflow | Trigger | Tier | Gating |
|---|---|---|---|
| `.github/workflows/ui-e2e.yaml` (new) | `pull_request` paths `ui/**` + `workflow_dispatch` | Tier 1 | **Blocking** required check (`ui-e2e`). Ship non-blocking first if desired; flip to required once green. |
| `.github/workflows/ui-e2e-cluster.yaml` (new) | `schedule` (nightly) + `push` to `master` + `workflow_dispatch` | Tier 2 | **Advisory** (posts a summary comment; never blocks). |

Both workflows: checkout → setup Node 22 → `npm ci` in `ui/` →
`npx playwright install --with-deps chromium` → run the tier orchestrator → upload
Playwright HTML report + traces/screenshots as a CI artifact on failure. Docker is
available on the ubuntu runners (the publish workflow already uses `docker buildx`).

## 9. Risks & mitigations

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Tier 1 Gogs restore drift from prod | Reuse the *same* `gogs-init.zip` + restore command as `apps/gogs/components/repo-init/`; no bespoke seed. |
| R2 | `k3d-config.yaml` host volume path is stale (`/home/alex/code/...` vs current cwd) | Make the path repo-relative or a CI temp dir; fix as part of Tier 2 setup. |
| R3 | `shell.nix` lacks `kubectl` (and `curl`/`jq`) | Add to `shell.nix`; Tier 2 + seeding depend on it. |
| R4 | Tier 2 boot time (~5–10 min) + image-pull flakiness | Off-critical-path cadence (nightly/on-merge); retries; artifact uploads. |
| R5 | Cosign/GHCR network dependency in Tier 2 | Inherent to testing the real supply chain; retries + nightly cadence absorb transient failures. |
| R6 | Install status stuck at `installing` misread as a failure | Document C2 in the suite; Tier 1 asserts commit, Tier 2 asserts reconciliation. |
| R7 | SPA-fallback test fails on reload | Expected; fix `serve-static` fallback (§7). |

## 10. Out of scope / future work

- Minimal-subset k3d cluster (~2–4 min boot) if Tier 2 ever needs to run per-PR.
- Promoting Tier 2 assertions into a faster gate.
- Cross-browser CI matrix; visual regression.
- E2E for non-UI marketplace surfaces (SSO controller, supply chain).

## 11. Implementation order (to be elaborated in the plan)

1. Scaffold `packages/e2e` workspace + Playwright config + POM + shared env.
2. Tier 1: compose Gogs (+restore) → seed → orchestrator → app-level specs → `ui-e2e.yaml`.
3. SPA-fallback fix + test.
4. Tier 2: k3d bootstrap reuse → image import → port-forward → cluster-level specs →
   `ui-e2e-cluster.yaml`; fix R2/R3.
5. Documentation: update `ui/CLAUDE.md` with the new commands, tiers, and local/CI run guide.
