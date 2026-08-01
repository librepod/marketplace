# Marketplace UI E2E — Tier 1 (Per-PR Blocking Gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hermetic, browser-driven Playwright e2e suite for the marketplace UI that runs as a blocking per-PR gate (and one-command locally), validating catalog browsing, app detail, install/uninstall against a real containerized Gogs, "My Apps", and SPA routing.

**Architecture:** A new `packages/e2e` npm workspace. An orchestrator builds the client+server from source, brings up a real `gogs/gogs` container seeded via the repo's existing `gogs-init.zip` backup-restore, verifies readiness, then Playwright drives the prod-like Nest server (which serves the built SPA + API on `:3000`) in Chromium. Tests target real accessible roles/text (no invented selectors). No cluster, no Flux — install is asserted at the commit-to-Gogs level (`installing` status, not `running`).

**Tech Stack:** Playwright (Chromium), Node 22, npm workspaces, docker compose, the existing NestJS+React+Vite app, `gogs/gogs` image + `gogs-init.zip`.

## Global Constraints

- **Node `>=22.0.0`** (workspace `engines`).
- **Commit hygiene:** never reference concrete device/cluster hostnames in commit messages or PRs — use `dev`/`prod`/`staging`. (Internal plan/spec docs may keep operational names.)
- **Naming:** new root script is `test:e2e:ui`. The existing server `test:e2e` (API-level) MUST remain untouched — no collision.
- **No new lint/test runner divergence:** Playwright owns its own config; do not modify server/client vitest configs.
- **Hermetic:** tests must not reach the real cluster, real GHCR, or the public network. Gogs is local containerized; the catalog is a committed fixture.
- **`GOGS_TOKEN` is a password:** the seeded Gogs user's *password* equals `GOGS_TOKEN`; Nest bootstraps its own API token at runtime. Seeded creds are `GOGS_USERNAME=flux`, `GOGS_TOKEN=pass@w0rd` (from `apps/gogs/components/repo-init/secret.env`).
- **`KUBERNETES_SERVICE_HOST` must be unset** in Tier 1 (no cluster) so `FluxStatusService` degrades to `installing` rather than touching a real kubeconfig.
- Selectors target **roles/text** (`getByRole`/`getByText`/`getByPlaceholder`); the only `data-testid` in the app is `app-card-skeleton`.

## File Structure

```
ui/packages/e2e/                         # NEW workspace
├── package.json                         # @librepod/e2e; dep @playwright/test
├── tsconfig.json                        # extends ../../tsconfig.base.json, module ESNext
├── .gitignore                           # test-results/, playwright-report/, .cache/
├── playwright.config.ts                 # shared base (reporters, retries, browser, artifacts)
├── projects/
│   └── tier1.config.ts                  # webServer env + baseURL + testDir for Tier 1
├── docker-compose.e2e.yml               # gogs-restore (one-shot) + gogs + volume
├── support/
│   ├── gogs/                            # resolved Gogs config for the container
│   │   └── app.ini
│   ├── gogs-ready.mjs                   # poll Gogs + verify token bootstrap + root kustomization
│   ├── run-tier1.sh                     # orchestrator: build → compose → ready → playwright → down -v
│   └── pages/                           # Page Object Model
│       ├── AppShell.ts
│       ├── CatalogPage.ts
│       └── AppDetailPage.ts
├── fixtures/
│   └── catalog.fixture.yaml             # 6 apps (3 user-facing); 2 have install templates
└── tests/
    └── app-level/
        ├── smoke.spec.ts                # boots the whole pipeline
        ├── catalog.spec.ts
        ├── app-detail.spec.ts
        ├── install-uninstall.spec.ts
        ├── my-apps.spec.ts
        └── resilience.spec.ts           # incl. deep-link reload (drives the SPA-fallback fix)
```

**Modified files:**
- `ui/package.json` — add `packages/e2e` to `workspaces`; add `test:e2e:ui` script.
- `ui/packages/server/src/app.module.ts` (or `main.ts`) — SPA fallback fix (Task 10).
- `ui/CLAUDE.md` — document the new command, tier model, and local run guide.
- `.github/workflows/ui-e2e.yaml` — NEW CI workflow.

---

### Task 1: Scaffold the `packages/e2e` workspace

**Files:**
- Create: `ui/packages/e2e/package.json`
- Create: `ui/packages/e2e/tsconfig.json`
- Create: `ui/packages/e2e/.gitignore`
- Create: `ui/packages/e2e/playwright.config.ts`
- Modify: `ui/package.json` (workspaces + script)

**Interfaces:**
- Produces: workspace `@librepod/e2e`; a base `playwright.config.ts` that tier configs extend; root script `test:e2e:ui` (wired in Task 4).

- [ ] **Step 1: Create `ui/packages/e2e/package.json`**

```json
{
  "name": "@librepod/e2e",
  "private": true,
  "type": "module",
  "scripts": {
    "test:e2e:ui": "bash support/run-tier1.sh"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0"
  }
}
```

- [ ] **Step 2: Create `ui/packages/e2e/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"],
    "lib": ["ES2022", "DOM"],
    "noEmit": true
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 3: Create `ui/packages/e2e/.gitignore`**

```
node_modules
/test-results/
/playwright-report/
/blob-report/
/playwright/.cache/
```

- [ ] **Step 4: Create the shared base `ui/packages/e2e/playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

// Shared defaults. Tier configs import this and override webServer/baseURL/testDir.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : "list",
  use: {
    browserName: "chromium",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
```

- [ ] **Step 5: Register the workspace + root script in `ui/package.json`**

Add `"packages/e2e"` to the `workspaces` array (after `packages/shared`), and add to `scripts`:

```jsonc
"test:e2e:ui": "npm run test:e2e:ui --workspace=packages/e2e",
```

- [ ] **Step 6: Install Playwright + browser**

Run (from `ui/`): `npm install`
Then: `cd packages/e2e && npx playwright install chromium`
Expected: Playwright installs the Chromium browser binary without error.

- [ ] **Step 7: Commit**

```bash
git add ui/package.json ui/packages/e2e
git commit -m "test(e2e): scaffold packages/e2e workspace with Playwright"
```

---

### Task 2: Catalog fixture with installable templates

**Files:**
- Create: `ui/packages/e2e/fixtures/catalog.fixture.yaml`

**Interfaces:**
- Produces: a catalog with 3 user-facing apps (vaultwarden, gogs, litellm) and 3 `Infrastructure` apps (filtered out). `vaultwarden` and `litellm` carry `templates` (+ `secrets[].generate` on vaultwarden) so install succeeds. `vaultwarden.sourceUrl` is `https://...` (so the "View project" link renders); `litellm.sourceUrl` is `oci://...` (link hidden) — covers both branches in Task 7.

- [ ] **Step 1: Create the fixture**

The template bodies are minimal valid YAML that reference only `${BASE_DOMAIN}` (always in the `vars` map) and generated secrets, so they render cleanly. The install flow writes `apps/<name>/{source,release,secret?,kustomization}.yaml` from these.

```yaml
apiVersion: marketplace/v1
kind: Catalog
metadata:
  generatedAt: "2026-01-01T00:00:00Z"
apps:
  - name: vaultwarden
    version: "1.35.2"
    displayName: Vaultwarden
    description: Lightweight Bitwarden-compatible password manager server
    category: Security
    icon: https://example.com/vaultwarden.png
    sourceType: oci-kustomize
    sourceUrl: https://github.com/dani-garcia/vaultwarden
    secrets:
      - name: ADMIN_TOKEN
        generate:
          length: 32
    templates:
      source: |
        apiVersion: source.toolkit.fluxcd.io/v1beta2
        kind: OCIRepository
        metadata:
          name: vaultwarden
          namespace: flux-system
        spec:
          url: oci://ghcr.io/librepod/marketplace/apps/vaultwarden
      release: |
        apiVersion: helm.toolkit.fluxcd.io/v2
        kind: HelmRelease
        metadata:
          name: vaultwarden
          namespace: vaultwarden
        spec:
          chart:
            spec:
              sourceRef:
                kind: OCIRepository
                name: vaultwarden
          values:
            domain: ${BASE_DOMAIN}
      secret: |
        apiVersion: v1
        kind: Secret
        metadata:
          name: vaultwarden-admin
          namespace: vaultwarden
        stringData:
          ADMIN_TOKEN: ${ADMIN_TOKEN}
      kustomization: |
        apiVersion: kustomize.config.k8s.io/v1beta1
        kind: Kustomization
        resources:
          - source.yaml
          - release.yaml
          - secret.yaml

  - name: gogs
    version: "1.1.0"
    displayName: Gogs
    description: Lightweight self-hosted Git service
    category: Development
    icon: https://example.com/gogs.png
    sourceType: oci-kustomize
    sourceUrl: oci://ghcr.io/librepod/marketplace/apps/gogs

  - name: litellm
    version: "1.81.9"
    displayName: LiteLLM
    description: Open-source API gateway for 100+ LLM providers
    category: AI
    icon: https://example.com/litellm.png
    sourceType: oci-kustomize
    sourceUrl: oci://ghcr.io/librepod/marketplace/apps/litellm
    templates:
      source: |
        apiVersion: source.toolkit.fluxcd.io/v1beta2
        kind: OCIRepository
        metadata:
          name: litellm
          namespace: flux-system
        spec:
          url: oci://ghcr.io/librepod/marketplace/apps/litellm
      release: |
        apiVersion: helm.toolkit.fluxcd.io/v2
        kind: HelmRelease
        metadata:
          name: litellm
          namespace: litellm
        spec:
          chart:
            spec:
              sourceRef:
                kind: OCIRepository
                name: litellm
          values:
            ingress:
              host: litellm.${BASE_DOMAIN}
      kustomization: |
        apiVersion: kustomize.config.k8s.io/v1beta1
        kind: Kustomization
        resources:
          - source.yaml
          - release.yaml

  - name: traefik
    version: "1.0.0"
    displayName: Traefik
    description: Cloud-native edge router and load balancer
    category: Infrastructure
    icon: https://example.com/traefik.png
    sourceType: oci-kustomize
    sourceUrl: oci://ghcr.io/librepod/marketplace/apps/traefik
  - name: cert-manager
    version: "1.0.0"
    displayName: Cert-Manager
    description: Cloud-native certificate management
    category: Infrastructure
    icon: https://example.com/cert-manager.png
    sourceType: oci-kustomize
    sourceUrl: oci://ghcr.io/librepod/marketplace/apps/cert-manager
  - name: nfs-provisioner
    version: "1.0.0"
    displayName: NFS Provisioner
    description: Kubernetes dynamic provisioner for NFS storage
    category: Infrastructure
    icon: https://example.com/nfs.png
    sourceType: oci-kustomize
    sourceUrl: oci://ghcr.io/librepod/marketplace/apps/nfs-provisioner
```

- [ ] **Step 2: Sanity-check the YAML parses**

Run (from `ui/`): `node -e "require('js-yaml').load(require('fs').readFileSync('packages/e2e/fixtures/catalog.fixture.yaml','utf8')); console.log('ok')"` — if `js-yaml` isn't resolvable at the root, use `node --input-type=module -e "import('js-yaml').then(y=>y.default.load(require('fs').readFileSync('packages/e2e/fixtures/catalog.fixture.yaml','utf8'))).then(()=>console.log('ok'))"` or simply `npx --yes js-yaml packages/e2e/fixtures/catalog.fixture.yaml >/dev/null && echo ok`.
Expected: prints `ok` (valid YAML).

- [ ] **Step 3: Commit**

```bash
git add ui/packages/e2e/fixtures/catalog.fixture.yaml
git commit -m "test(e2e): add catalog fixture with installable templates"
```

---

### Task 3: Gogs container (backup-restore) + readiness verifier

**Files:**
- Create: `ui/packages/e2e/docker-compose.e2e.yml`
- Create: `ui/packages/e2e/support/gogs/app.ini`
- Create: `ui/packages/e2e/support/gogs-ready.mjs`

**Interfaces:**
- Produces: a compose stack that yields a healthy Gogs at `http://127.0.0.1:43000`, seeded with user `flux` / repo `flux/user-apps` / root `kustomization.yaml` (`resources: []`). `gogs-ready.mjs` exits 0 only when token-bootstrap + root-kustomization read succeed.

- [ ] **Step 1: Create the resolved Gogs config `ui/packages/e2e/support/gogs/app.ini`**

The repo's `apps/gogs/base/app.ini` contains Flux `${BASE_DOMAIN:=libre.pod}` placeholders; Gogs itself does no env substitution, so we resolve them here.

```ini
[server]
DOMAIN = git.libre.pod
HTTP_PORT = 3000
EXTERNAL_URL = http://git.libre.pod/
DISABLE_SSH = true

[database]
TYPE = sqlite3
PATH = /data/gogs.db

[repository]
ROOT = /data/git/gogs-repositories

[security]
INSTALL_LOCK = true

[auth]
REQUIRE_SIGNIN_VIEW = true
```

- [ ] **Step 2: Create `ui/packages/e2e/docker-compose.e2e.yml`**

Mirrors the prod `repo-init` initContainer: a one-shot `gogs-restore` service runs `./gogs restore --from /data/gogs-init.zip` into a shared volume; `gogs` starts only after it completes.

```yaml
services:
  gogs-restore:
    image: gogs/gogs:0.14.2
    user: "1000"
    volumes:
      - gogs-data:/data
      - ../../apps/gogs/components/repo-init/gogs-init.zip:/data/gogs-init.zip:ro
      - ./support/gogs:/gogs-config:ro
    entrypoint: ["sh", "-c"]
    command:
      - >
        mkdir -p /data/gogs/conf &&
        cp /gogs-config/app.ini /data/gogs/conf/app.ini &&
        cd /app/gogs &&
        ./gogs restore --from /data/gogs-init.zip --config /data/gogs/conf/app.ini
    restart: "no"

  gogs:
    image: gogs/gogs:0.14.2
    depends_on:
      gogs-restore:
        condition: service_completed_successfully
    ports:
      - "127.0.0.1:43000:3000"
    volumes:
      - gogs-data:/data

volumes:
  gogs-data:
```

> **Note for the implementer:** if `gogs/gogs:0.14.2` is unavailable, fall back to `gogs/gogs:0.14` then `:next-0.14` (the tag the prod overlay pins). The backup is Gogs `0.14.2`; stay on `0.14.x`.

- [ ] **Step 3: Create `ui/packages/e2e/support/gogs-ready.mjs`**

Polls Gogs `/api/v1/version`, then proves the seeded state is usable by bootstrapping a token (Basic auth `flux:pass@w0rd`, exactly as `GogsService.onModuleInit` does) and reading the root `kustomization.yaml`.

```js
// Waits for Gogs, then verifies: (1) token bootstrap works, (2) root kustomization is readable.
// Exits 0 only when the seeded state is usable by the marketplace server.
const GOGS_URL = process.env.GOGS_URL ?? "http://127.0.0.1:43000";
const USERNAME = process.env.GOGS_USERNAME ?? "flux";
const PASSWORD = process.env.GOGS_TOKEN ?? "pass@w0rd";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForVersion(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${GOGS_URL}/api/v1/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(1000);
  }
  throw new Error(`Gogs did not become ready at ${GOGS_URL} within ${timeoutMs}ms`);
}

async function bootstrapToken() {
  const basic = Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");
  const r = await fetch(`${GOGS_URL}/api/v1/users/${USERNAME}/tokens`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `e2e-ready-${Math.random().toString(36).slice(2, 10)}` }),
  });
  if (!r.ok) throw new Error(`token bootstrap failed: ${r.status} ${await r.text()}`);
  return (await r.json()).sha1;
}

const v = await waitForVersion();
console.log(`Gogs up (version ${v.version}). Verifying seeded state...`);

const token = await bootstrapToken();
const kr = await fetch(
  `${GOGS_URL}/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml`,
  { headers: { Authorization: `token ${token}` } },
);
if (!kr.ok) throw new Error(`root kustomization read failed: ${kr.status}`);
const body = await kr.text();
if (!/resources:\s*\[\]/.test(body))
  throw new Error(`root kustomization not in expected empty state:\n${body}`);

console.log("Gogs ready: token bootstrap OK, flux/user-apps root kustomization verified.");
```

- [ ] **Step 4: Bring up Gogs and verify readiness**

Run (from `ui/`):

```bash
docker compose -f packages/e2e/docker-compose.e2e.yml up -d
node packages/e2e/support/gogs-ready.mjs
```

Expected: prints `Gogs up ...` then `Gogs ready: token bootstrap OK ...` and exits 0. If the restore step fails, inspect `docker compose -f packages/e2e/docker-compose.e2e.yml logs gogs-restore` and adjust the image tag or mount paths. Tear down with `docker compose -f packages/e2e/docker-compose.e2e.yml down -v`.

- [ ] **Step 5: Commit**

```bash
git add ui/packages/e2e/docker-compose.e2e.yml ui/packages/e2e/support/gogs ui/packages/e2e/support/gogs-ready.mjs
git commit -m "test(e2e): add Gogs backup-restore compose stack and readiness verifier"
```

---

### Task 4: Tier 1 Playwright config + orchestrator + smoke test

**Files:**
- Create: `ui/packages/e2e/projects/tier1.config.ts`
- Create: `ui/packages/e2e/support/run-tier1.sh`
- Create: `ui/packages/e2e/tests/app-level/smoke.spec.ts`

**Interfaces:**
- Consumes: workspace + base config (Task 1); fixture (Task 2); compose + readiness (Task 3); the built app (`packages/{client,server}/dist`).
- Produces: `npm run test:e2e:ui` that boots the whole pipeline; a green smoke test proves build → Gogs → Nest → browser all wire up. Page objects (Task 5) and specs (Tasks 6–10) target `baseURL = http://localhost:3000`.

- [ ] **Step 1: Create `ui/packages/e2e/projects/tier1.config.ts`**

```ts
import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

export default defineConfig({
  ...base,
  testDir: "../tests/app-level",
  use: {
    ...base.use,
    baseURL: "http://localhost:3000",
  },
  webServer: {
    // Orchestrator already built client+server; this just serves the prod-like app.
    command: "node packages/server/dist/main.js",
    cwd: process.cwd(),
    env: {
      PORT: "3000",
      CATALOG_PATH: `${process.cwd()}/packages/e2e/fixtures/catalog.fixture.yaml`,
      GOGS_URL: "http://127.0.0.1:43000",
      GOGS_USERNAME: "flux",
      GOGS_TOKEN: "pass@w0rd", // NB: used as the Basic-auth PASSWORD by GogsService
      BASE_DOMAIN: "libre.pod",
      ALLOWED_ORIGINS: "http://localhost:3000",
      // KUBERNETES_SERVICE_HOST intentionally unset → FluxStatusService degrades to "installing".
    },
    url: "http://localhost:3000/api/health",
    reuseExistingServer: false, // always start a server matching the fresh build
    timeout: 60_000,
  },
});
```

- [ ] **Step 2: Create `ui/packages/e2e/support/run-tier1.sh`**

```bash
#!/usr/bin/env bash
# Tier 1 orchestrator: build → Gogs up → readiness → Playwright → teardown.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UI_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE="$UI_ROOT/packages/e2e/docker-compose.e2e.yml"
E2E="$UI_ROOT/packages/e2e"

cleanup() {
  echo "Tearing down Gogs..."
  docker compose -f "$COMPOSE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$UI_ROOT"

echo "==> Building client + server"
npm run build:client
npm run build

echo "==> Starting Gogs (backup-restore)"
docker compose -f "$COMPOSE" up -d

echo "==> Verifying Gogs readiness"
GOGS_URL="http://127.0.0.1:43000" GOGS_USERNAME="flux" GOGS_TOKEN="pass@w0rd" \
  node "$E2E/support/gogs-ready.mjs"

echo "==> Running Playwright (Tier 1)"
npx playwright test --config "$E2E/projects/tier1.config.ts" "$@"
```

Make it executable: `chmod +x ui/packages/e2e/support/run-tier1.sh`

- [ ] **Step 3: Write the smoke spec `ui/packages/e2e/tests/app-level/smoke.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

// Validates the whole pipeline: built SPA served by Nest, API reachable, Gogs wired.
test("app boots and catalog API returns seeded apps", async ({ page, request }) => {
  const apps = await request.get("/api/apps");
  expect(apps.ok()).toBeTruthy();
  const body = await apps.json();
  const names = body.apps.map((a: { name: string }) => a.name);
  // Infrastructure apps are filtered out server-side.
  expect(names).toEqual(expect.arrayContaining(["vaultwarden", "gogs", "litellm"]));
  expect(names).not.toContain("traefik");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "LibrePod", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Vaultwarden" })).toBeVisible();
});
```

- [ ] **Step 4: Run the orchestrator**

Run (from `ui/`): `npm run test:e2e:ui`
Expected: build succeeds, Gogs becomes ready, the smoke test passes (catalog API returns the 3 user-facing apps; the SPA renders the header + a Vaultwarden card). If Playwright can't reach `/api/health`, confirm the server booted (`node packages/server/dist/main.js` with the Tier 1 env in a separate terminal) and that `CATALOG_PATH` resolves.

- [ ] **Step 5: Commit**

```bash
git add ui/packages/e2e/projects ui/packages/e2e/support/run-tier1.sh ui/packages/e2e/tests
git commit -m "test(e2e): add Tier 1 config, orchestrator, and smoke test"
```

---

### Task 5: Page Object Model

**Files:**
- Create: `ui/packages/e2e/support/pages/AppShell.ts`
- Create: `ui/packages/e2e/support/pages/CatalogPage.ts`
- Create: `ui/packages/e2e/support/pages/AppDetailPage.ts`

**Interfaces:**
- Consumes: Playwright `Page`/`Locator`; the verified DOM contract (roles/text).
- Produces: page objects the specs (Tasks 6–10) import: `CatalogPage(page)`, `AppDetailPage(page)`, `AppShell(page)` with the methods named below.

- [ ] **Step 1: Create `AppShell.ts`**

```ts
import type { Page, Locator } from "@playwright/test";

export class AppShell {
  constructor(private readonly page: Page) {}

  nav(): Locator {
    return this.page.getByRole("navigation", { name: "Main navigation" });
  }
  goToCatalog(): Promise<void> { return this.nav().getByRole("link", { name: "Catalog" }).click(); }
  goToMyApps(): Promise<void> { return this.nav().getByRole("link", { name: "My Apps" }).click(); }
  toast(text: string): Locator { return this.page.getByRole("status").filter({ hasText: text }); }
}
```

> **Note:** sonner toasts render with `role="status"` in the bottom-right. If the role is absent in a future sonner version, switch to `page.getByText(text)`.

- [ ] **Step 2: Create `CatalogPage.ts`**

```ts
import type { Page, Locator } from "@playwright/test";

export class CatalogPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> { await this.page.goto("/"); }
  async gotoWith(query?: string, category?: string): Promise<void> {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (category) params.set("category", category);
    const qs = params.toString();
    await this.page.goto(qs ? `/?${qs}` : "/");
  }

  card(displayName: string): Locator {
    return this.page.getByRole("link", { name: displayName, exact: true });
  }
  skeletonCount(): Promise<number> { return this.page.getByTestId("app-card-skeleton").count(); }

  searchBox(): Locator { return this.page.getByRole("textbox", { name: "Search apps" }); }
  async search(text: string): Promise<void> {
    await this.searchBox().fill(text);
  }
  clearSearch(): Promise<void> { return this.page.getByRole("button", { name: "Clear search" }).click(); }

  categoryGroup(): Locator { return this.page.getByRole("group", { name: "Filter by category" }); }
  chip(label: string): Locator {
    return this.categoryGroup().getByRole("button", { name: label, exact: true });
  }
  async selectCategory(label: string): Promise<void> { await this.chip(label).click(); }

  noMatchesHeading(): Locator { return this.page.getByRole("heading", { name: "No apps found" }); }
  clearFilters(): Locator { return this.page.getByRole("button", { name: "Clear filters" }); }
}
```

- [ ] **Step 3: Create `AppDetailPage.ts`**

```ts
import type { Page, Locator } from "@playwright/test";

export class AppDetailPage {
  constructor(private readonly page: Page) {}

  async open(name: string): Promise<void> { await this.page.goto(`/apps/${name}`); }
  async backToCatalog(): Promise<void> {
    await this.page.getByRole("link", { name: "← Back to catalog" }).click();
  }

  title(): Locator { return this.page.getByRole("heading", { level: 1 }); }
  statusBadge(): Locator { return this.page.getByRole("status"); }
  viewProjectLink(): Locator { return this.page.getByRole("link", { name: "View project" }); }

  installButton(): Locator { return this.page.getByRole("button", { name: "Install App" }); }
  uninstallButton(): Locator { return this.page.getByRole("button", { name: "Uninstall App" }); }

  async confirmUninstall(): Promise<void> {
    await this.uninstallButton().click();
    await this.page.getByRole("button", { name: "Uninstall App" }).nth(1).click();
  }
  keepApp(): Locator { return this.page.getByRole("button", { name: "Keep App" }); }
}
```

> **Note on the confirm dialog:** the `AlertDialog` trigger AND the confirm action both read "Uninstall App" (the trigger shows "Uninstall App"; the action inside the dialog also reads "Uninstall App"). The `.nth(1)` selects the dialog's action button after the trigger opens the dialog. Verify the exact text by running Task 8's first failing step; adjust the index if the trigger label differs while pending.

- [ ] **Step 4: Typecheck**

Run (from `ui/packages/e2e`): `npx tsc --noEmit`
Expected: no errors. (If `@playwright/test` types aren't found, run `npm install` at the workspace root first.)

- [ ] **Step 5: Commit**

```bash
git add ui/packages/e2e/support/pages
git commit -m "test(e2e): add page object model for catalog/detail/shell"
```

---

### Task 6: Catalog spec

**Files:**
- Create: `ui/packages/e2e/tests/app-level/catalog.spec.ts`

**Interfaces:**
- Consumes: `CatalogPage` (Task 5), `baseURL`, fixture apps (vaultwarden/gogs/litellm user-facing; traefik filtered).

- [ ] **Step 1: Write the catalog spec**

```ts
import { test, expect } from "@playwright/test";
import { CatalogPage } from "../../support/pages/CatalogPage";

test.describe("Catalog page", () => {
  test("renders all user-facing apps and filters out Infrastructure", async ({ page }) => {
    const catalog = new CatalogPage(page);
    await catalog.goto();
    await expect(catalog.card("Vaultwarden")).toBeVisible();
    await expect(catalog.card("Gogs")).toBeVisible();
    await expect(catalog.card("LiteLLM")).toBeVisible();
    await expect(catalog.card("Traefik")).toHaveCount(0);
  });

  test("search filters by displayName/description (case-insensitive)", async ({ page }) => {
    const catalog = new CatalogPage(page);
    await catalog.goto();
    await catalog.search("lite");
    await expect(catalog.card("LiteLLM")).toBeVisible();
    await expect(catalog.card("Vaultwarden")).toHaveCount(0);
  });

  test("search yields a no-matches state and Clear filters resets", async ({ page }) => {
    const catalog = new CatalogPage(page);
    await catalog.goto();
    await catalog.search("zzzznomatch");
    await expect(catalog.noMatchesHeading()).toBeVisible();
    await catalog.clearFilters();
    await expect(catalog.card("Vaultwarden")).toBeVisible();
  });

  test("category chips are single-select and update the URL", async ({ page }) => {
    const catalog = new CatalogPage(page);
    await catalog.goto();
    await catalog.selectCategory("Security");
    await expect(page).toHaveURL(/category=Security/);
    await expect(catalog.card("Vaultwarden")).toBeVisible();
    await expect(catalog.card("LiteLLM")).toHaveCount(0);
    // "All" clears the category
    await catalog.chip("All").click();
    await expect(page).not.toHaveURL(/category=/);
  });

  test("deep-link ?q= and ?category= populate the controls", async ({ page }) => {
    const catalog = new CatalogPage(page);
    await catalog.gotoWith("git", "Development");
    await expect(catalog.searchBox()).toHaveValue("git");
    await expect(catalog.chip("Development")).toHaveAttribute("aria-pressed", "true");
    await expect(catalog.card("Gogs")).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the spec**

Run (from `ui/`): `npm run test:e2e:ui -- tests/app-level/catalog.spec.ts`
Expected: all 5 tests pass. (Playwright forwards `--` args; the orchestrator's `"$@"` passes the path filter to `playwright test`.)

- [ ] **Step 3: Commit**

```bash
git add ui/packages/e2e/tests/app-level/catalog.spec.ts
git commit -m "test(e2e): cover catalog rendering, search, category filters, URL sync"
```

---

### Task 7: App detail spec

**Files:**
- Create: `ui/packages/e2e/tests/app-level/app-detail.spec.ts`

**Interfaces:**
- Consumes: `CatalogPage`, `AppDetailPage` (Task 5). `vaultwarden` (https sourceUrl → link visible), `litellm` (oci sourceUrl → link hidden), `gogs` (no templates).

- [ ] **Step 1: Write the detail spec**

```ts
import { test, expect } from "@playwright/test";
import { CatalogPage } from "../../support/pages/CatalogPage";
import { AppDetailPage } from "../../support/pages/AppDetailPage";

test.describe("App detail page", () => {
  test("navigates from a card and renders metadata + install action", async ({ page }) => {
    const catalog = new CatalogPage(page);
    const detail = new AppDetailPage(page);
    await catalog.goto();
    await catalog.card("Vaultwarden").click();
    await expect(page).toHaveURL(/\/apps\/vaultwarden/);
    await expect(detail.title()).toHaveText("Vaultwarden");
    await expect(page.getByText("1.35.2", { exact: true })).toBeVisible();
    await expect(detail.installButton()).toBeVisible();
    await expect(detail.uninstallButton()).toHaveCount(0); // not_installed → no uninstall
  });

  test("shows View project link only for http(s) sourceUrl", async ({ page }) => {
    const detail = new AppDetailPage(page);

    await detail.open("vaultwarden"); // sourceUrl: https://...
    await expect(detail.viewProjectLink()).toBeVisible();
    await expect(detail.viewProjectLink()).toHaveAttribute(
      "href",
      "https://github.com/dani-garcia/vaultwarden",
    );

    await detail.open("litellm"); // sourceUrl: oci://... → link hidden
    await expect(detail.viewProjectLink()).toHaveCount(0);
  });

  test("unknown app shows the not-found state", async ({ page }) => {
    await page.goto("/apps/does-not-exist");
    await expect(page.getByRole("heading", { name: "App not found" })).toBeVisible();
    await expect(page.getByText("This app doesn't exist in the catalog.")).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the spec**

Run (from `ui/`): `npm run test:e2e:ui -- tests/app-level/app-detail.spec.ts`
Expected: all 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add ui/packages/e2e/tests/app-level/app-detail.spec.ts
git commit -m "test(e2e): cover app detail nav, metadata, view-project link, not-found"
```

---

### Task 8: Install / uninstall spec (real Gogs)

**Files:**
- Create: `ui/packages/e2e/tests/app-level/install-uninstall.spec.ts`

**Interfaces:**
- Consumes: `AppDetailPage`, `AppShell` (Task 5); real Gogs via the server.
- **Reachability constraint (critical):** with no cluster, post-install status is stuck at `installing`. The action-button logic renders **only a disabled "Installing…" button** at `installing` status — there is **no Uninstall action**, and the **"Open" link only renders at `running`**. Therefore the Uninstall `AlertDialog` UX and the "Open" link are **unreachable via the UI in Tier 1** and are deferred to Tier 2 (cluster). Tier 1 covers: install happy-path (UI), uninstall (API-level), and install-when-already-installed (409).

- [ ] **Step 1: Write the install/uninstall spec**

```ts
import { test, expect } from "@playwright/test";
import { AppDetailPage } from "../../support/pages/AppDetailPage";
import { AppShell } from "../../support/pages/AppShell";

// Uninstall is exercised API-only here: the Uninstall AlertDialog is only reachable
// at status running/error, which requires a cluster (Tier 2).
test.describe("install / uninstall against real Gogs", () => {
  test("install commits to Gogs and transitions the UI to installing", async ({ page, request }) => {
    const detail = new AppDetailPage(page);
    const shell = new AppShell(page);
    await detail.open("litellm");

    await detail.installButton().click();
    await expect(shell.toast("Install started")).toBeVisible();

    // The install action becomes a disabled "Installing…" button (status installing).
    await expect(page.getByRole("button", { name: "Installing..." })).toBeDisabled();
    await expect(detail.statusBadge()).toHaveText(/Installing/);

    // App now appears in /api/installed (server derives this from the root kustomization,
    // so membership transitively proves the apps/<name> entry was appended).
    await expect.poll(
      async () =>
        (await (await request.get("/api/installed")).json()).apps.map(
          (a: { name: string }) => a.name,
        ),
      { message: "litellm enters /api/installed", timeout: 15_000 },
    ).toContain("litellm");
  });

  test("install-when-already-installed is refused (409)", async ({ request }) => {
    const r = await request.post("/api/apps/litellm/install");
    expect(r.status()).toBe(409);
  });

  test("uninstall (API) removes the app and restores the Install action", async ({ page, request }) => {
    const detail = new AppDetailPage(page);

    const r = await request.post("/api/apps/litellm/uninstall");
    expect(r.ok()).toBeTruthy();

    await expect.poll(
      async () =>
        (await (await request.get("/api/installed")).json()).apps.map(
          (a: { name: string }) => a.name,
        ),
      { message: "litellm leaves /api/installed", timeout: 15_000 },
    ).not.toContain("litellm");

    // Detail reverts to not_installed → Install App button returns.
    await detail.open("litellm");
    await expect(detail.installButton()).toBeVisible();
  });
});
```

> **Deferred to Tier 2 (cluster, status `running`):** the Uninstall `AlertDialog` flow (open dialog → "Keep App" cancels → confirm "Uninstall App" → "Uninstall started" toast) and the "Open {app}" link. The page-object methods `AppDetailPage.confirmUninstall()` / `.keepApp()` / `.uninstallButton()` (Task 5) exist for Tier 2 to consume.

- [ ] **Step 2: Run the spec**

Run (from `ui/`): `npm run test:e2e:ui -- tests/app-level/install-uninstall.spec.ts`
Expected: all 3 tests pass. If `install-when-already-installed` returns non-409, check `InstalledService.install`'s `ConflictException` path and the exact status code. If the confirm-dialog button index is off, adjust `AppDetailPage.confirmUninstall()` (Task 5 note).

- [ ] **Step 3: Commit**

```bash
git add ui/packages/e2e/tests/app-level/install-uninstall.spec.ts
git commit -m "test(e2e): cover install/uninstall lifecycle against real Gogs"
```

---

### Task 9: My Apps spec

**Files:**
- Create: `ui/packages/e2e/tests/app-level/my-apps.spec.ts`

**Interfaces:**
- Consumes: `AppShell`, `AppDetailPage` (Task 5). Empty state before any install; populated after.
- **Reachability constraint:** the "Open {app}" link renders only at status `running` (unreachable in Tier 1) → it is **deferred to Tier 2**. Tier 1 asserts the empty state and that an installed app appears in the grid (with an "Installing" badge).

- [ ] **Step 1: Write the My Apps spec**

```ts
import { test, expect } from "@playwright/test";
import { AppShell } from "../../support/pages/AppShell";
import { AppDetailPage } from "../../support/pages/AppDetailPage";

test.describe("My Apps page", () => {
  test("empty state when nothing is installed", async ({ page, request }) => {
    // Ensure clean slate.
    for (const name of ["vaultwarden", "litellm"]) {
      const r = await request.get(`/api/apps/${name}`);
      if (r.ok() && (await r.json()).apps?.[0]?.installedStatus !== "not_installed") {
        await request.post(`/api/apps/${name}/uninstall`);
      }
    }
    await page.goto("/my-apps");
    await expect(page.getByRole("heading", { name: "No apps installed yet" })).toBeVisible();
  });

  test("installed app appears in the grid", async ({ page }) => {
    const shell = new AppShell(page);
    const detail = new AppDetailPage(page);

    await detail.open("vaultwarden");
    await detail.installButton().click();
    await expect(shell.toast("Install started")).toBeVisible();

    await shell.goToMyApps();
    const card = page.getByRole("link", { name: "Vaultwarden", exact: true });
    await expect(card).toBeVisible();
    // status is 'installing' (no cluster) → badge present, no "running".
    await expect(card.getByRole("status")).toHaveText(/Installing/);
  });
});
```

> **Deferred to Tier 2:** the "Open {app}" → `https://{name}.{baseDomain}` link assertion (requires `running` status, reachable only with a cluster).

- [ ] **Step 2: Run the spec**

Run (from `ui/`): `npm run test:e2e:ui -- tests/app-level/my-apps.spec.ts`
Expected: both tests pass.

- [ ] **Step 3: Commit**

```bash
git add ui/packages/e2e/tests/app-level/my-apps.spec.ts
git commit -m "test(e2e): cover My Apps empty state and installed-app Open link"
```

---

### Task 10: Resilience + SPA-fallback fix (TDD)

**Files:**
- Create: `ui/packages/e2e/tests/app-level/resilience.spec.ts`
- Modify: `ui/packages/server/src/main.ts`
- Modify: `ui/packages/server/package.json` (add `connect-history-api-fallback` dep)

**Interfaces:**
- Consumes: server `/api/config`, the SPA deep-link behavior.
- Produces: a passing deep-link reload test (currently fails — no `serve-static` fallback); the fix makes `/my-apps` (and all client routes) reloadable without 404. **Must not** regress `/api/*` or static assets.

- [ ] **Step 1: Write the failing deep-link test**

Create `ui/packages/e2e/tests/app-level/resilience.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test.describe("resilience", () => {
  test("catalog renders despite flux-unreachable (graceful degradation)", async ({ page }) => {
    // No KUBERNETES_SERVICE_HOST → FluxStatusService degrades silently.
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Vaultwarden" })).toBeVisible();
    // Install buttons are actionable even without a cluster.
    await page.getByRole("link", { name: "Vaultwarden" }).click();
    await expect(page.getByRole("button", { name: "Install App" })).toBeVisible();
  });

  test("deep-link reload on a client route does not 404", async ({ page }) => {
    // Navigate client-side, then reload — must serve index.html (SPA fallback).
    await page.goto("/");
    await page.getByRole("link", { name: "My Apps" }).click();
    await expect(page).toHaveURL(/\/my-apps/);
    await page.reload();
    await expect(page.getByRole("heading", { name: /My Apps/ })).toBeVisible();
    expect(page.url()).toMatch(/\/my-apps/);
  });
});
```

- [ ] **Step 2: Run to confirm the deep-link test fails**

Run (from `ui/`): `npm run test:e2e:ui -- tests/app-level/resilience.spec.ts`
Expected: the "deep-link reload" test FAILS (the reload of `/my-apps` returns a 404 / not the SPA). The degradation test should pass.

- [ ] **Step 3: Add the SPA-fallback dependency**

In `ui/packages/server/package.json`, add to `dependencies`:

```json
"connect-history-api-fallback": "^2.0.0"
```

Then (from `ui/`): `npm install`.

- [ ] **Step 4: Wire `connect-history-api-fallback` in `main.ts`**

History-fallback must be registered **before** `ServeStaticModule`'s static middleware so that rewritten requests are served as `index.html`. `app.use(...)` called right after `create()` and before `app.init()`/`listen()` registers first. `connect-history-api-fallback` only rewrites GET requests that `Accept: text/html` and have no file extension — so `/api/*` (JSON) and JS/CSS assets (dots) are untouched.

Edit `ui/packages/server/src/main.ts`:

```ts
import history from "connect-history-api-fallback";
// ... existing NestFactory.create() ...

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // SPA fallback: serve index.html for client-side routes on direct load/refresh.
  // Runs before ServeStaticModule (registered during app.init) so rewrites resolve to /.
  // /api/* and static assets are unaffected (JSON Accept / dot-rule).
  app.use(history());

  app.setGlobalPrefix("api");
  app.enableCors({
    origin: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
      .split(",")
      .map((s) => s.trim()),
  });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

(Preserve any existing bootstrap structure; the essential change is adding `app.use(history())` before `setGlobalPrefix`/`listen`, and the `import`.)

- [ ] **Step 5: Run the full suite to confirm the fix AND no regressions**

Run (from `ui/`): `npm run test:e2e:ui`
Expected: ALL Tier 1 tests pass, including the previously-failing deep-link test. Critically, the catalog/`/api/apps` smoke test still passes (proving `/api/*` is unaffected) and JS/CSS assets still load (the SPA renders). If `/api/*` breaks, the registration order is wrong — move `app.use(history())` earlier or register it via a Nest `MiddlewareConsumer` with `.exclude("api")`.

- [ ] **Step 6: Commit**

```bash
git add ui/packages/e2e/tests/app-level/resilience.spec.ts ui/packages/server/src/main.ts ui/packages/server/package.json ui/package-lock.json
git commit -m "fix(server): add SPA fallback so client routes don't 404 on reload

Drives the e2e deep-link test; history fallback leaves /api and static
assets untouched (JSON Accept + dot-rule)."
```

---

### Task 11: CI workflow (blocking per-PR gate)

**Files:**
- Create: `.github/workflows/ui-e2e.yaml`

**Interfaces:**
- Consumes: `npm run test:e2e:ui` (Task 4); Docker on the runner.

- [ ] **Step 1: Create `.github/workflows/ui-e2e.yaml`**

```yaml
name: ui-e2e

on:
  pull_request:
    paths:
      - "ui/**"
      - ".github/workflows/ui-e2e.yaml"
  workflow_dispatch:

jobs:
  tier1:
    name: Tier 1 (Playwright, hermetic)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ui
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: ui/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browser
        run: npx playwright install --with-deps chromium

      - name: Run Tier 1 e2e
        run: npm run test:e2e:ui

      - name: Upload Playwright report
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: ui/packages/e2e/playwright-report
          retention-days: 14

      - name: Upload test results (traces/screenshots)
        if: ${{ failure() }}
        uses: actions/upload-artifact@v4
        with:
          name: playwright-test-results
          path: ui/packages/e2e/test-results
          retention-days: 7
```

- [ ] **Step 2: Validate the workflow file**

Run (from repo root): `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ui-e2e.yaml')); print('valid')"` (or `npx --yes js-yaml .github/workflows/ui-e2e.yaml >/dev/null && echo valid`).
Expected: prints `valid`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ui-e2e.yaml
git commit -m "ci(ui): add blocking e2e workflow for UI changes"
```

> **Gating note:** the `ui-e2e` check should be added as a **required** status check on the default branch's branch protection. Recommended rollout: run it **non-required** for the first ~5 PRs to confirm stability, then flip to required. (This phasing is the only manual step; it's a repo-settings change, not code.)

---

### Task 12: Documentation

**Files:**
- Modify: `ui/CLAUDE.md`

**Interfaces:**
- None (docs).

- [ ] **Step 1: Add an E2E section to `ui/CLAUDE.md`**

Under the existing "## Commands" → "Test" block, add a new subsection:

````markdown
### E2E (browser, Playwright)

Browser-driven e2e lives in `packages/e2e` (Tier 1 — hermetic, per-PR gate). It builds
the client+server, brings up a real `gogs/gogs` container seeded from the repo's
`gogs-init.zip` backup, and drives the prod-like Nest server with Chromium.

```bash
npm run test:e2e:ui                          # full run (build → Gogs → Playwright → teardown)
npm run test:e2e:ui -- tests/app-level/catalog.spec.ts   # one spec file
```

Conventions:
- **Hermetic:** no cluster, no real GHCR. Gogs is local; the catalog is
  `packages/e2e/fixtures/catalog.fixture.yaml` (some apps have `templates` so install
  is exercisable). `KUBERNETES_SERVICE_HOST` is unset → post-install status is
  `installing`, never `running` (that's Tier 2's job).
- **`GOGS_TOKEN` is the Gogs user password**, not a bearer token — creds are
  `GOGS_USERNAME=flux` / `GOGS_TOKEN=pass@w0rd` (from `apps/gogs/components/repo-init/secret.env`).
- Selectors target roles/text (`getByRole`/`getByText`); the only `data-testid` is
  `app-card-skeleton`. Page objects live in `packages/e2e/support/pages`.
- CI: `.github/workflows/ui-e2e.yaml` runs Tier 1 on every PR touching `ui/**`.
- Tier 2 (k3d cluster, full Flux reconciliation) is a separate follow-up plan.
````

- [ ] **Step 2: Commit**

```bash
git add ui/CLAUDE.md
git commit -m "docs(ui): document the Tier 1 e2e suite and conventions"
```

---

## Self-Review

**Spec coverage** (against `docs/marketplace-ui-e2e-design.md`):
- §2 Goals 1–2 (browser e2e + per-PR gate): Tasks 1, 4, 6–10, 11. ✅
- §5.1 workspace layout: Task 1. ✅
- §5.2 Tier 1 lifecycle (build → compose → ready → playwright): Tasks 2, 3, 4. ✅
- §5.4 shared core (POM, flakiness defenses): Tasks 1 (retries/trace), 5. ✅
- §6 Tier 1 test inventory (catalog/detail/install-uninstall/my-apps/resilience): Tasks 6–10. ✅ (with the divergence below)
- §7 SPA-fallback fix: Task 10 (TDD). ✅
- §7 browser matrix (Chromium): Task 1 config. ✅
- §7 naming (`test:e2e:ui`): Task 1. ✅
- §8 CI workflow (Tier 1 blocking): Task 11. ✅
- §11 implementation order steps 1–3, 5 (scaffold → Tier 1 → SPA fix → docs): Tasks 1–10, 12. ✅
- Tier 2 (§5.3, §8 cluster workflow, R2/R3 infra fixes): **deferred to Plan 2** (called out in Task 12 docs + Global Constraints). Intentional decomposition.

**Divergence from spec §6 (intentional, surfaced during self-review):** the spec's `install-uninstall.spec.ts` row lists "uninstall: confirm `AlertDialog` → …" and `my-apps.spec.ts` lists "Open {app} → https://…". Both require status `running`/`error`, which is **unreachable without a cluster** (Tier 1 status is stuck at `installing`). The plan therefore covers uninstall at the API level in Tier 1 (Task 8) and **moves the `AlertDialog` UX + "Open" link to Tier 2**. Update spec §6 to match if you want them kept in sync.

**Placeholder scan:** No TBD/TODO/"add error handling". Empirical integration points (Gogs image tag, confirm-dialog button index, Open-link status gating) each carry a concrete verification step + fallback, not a placeholder.

**Type consistency:** `CatalogPage`, `AppDetailPage`, `AppShell` method names are identical across Tasks 5 (definition) and 6–9 (callers). Env var names match the server contract (`GOGS_URL`, `GOGS_USERNAME`, `GOGS_TOKEN`, `CATALOG_PATH`, `BASE_DOMAIN`, `ALLOWED_ORIGINS`).

**Scope:** Single coherent plan (Tier 1); produces a working, blocking per-PR gate. Tier 2 is a deliberate follow-up.
