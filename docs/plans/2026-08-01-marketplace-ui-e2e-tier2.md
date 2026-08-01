# Marketplace UI E2E — Tier 2 (k3d Cluster, Nightly/Advisory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Plan 1 (Tier 1) is implemented — Tier 2 reuses the `packages/e2e` workspace, the shared `playwright.config.ts`, and the Page Object Model (`support/pages/`) produced by Plan 1.

**Goal:** Add a realistic, deployment-level e2e tier that boots the whole marketplace in an ephemeral k3d cluster (real Flux, real Gogs, real CRDs, the published image) and asserts the full GitOps lifecycle — install reconciling to `running`, the Uninstall `AlertDialog`, and the "Open" link — i.e. the flows Tier 1 structurally cannot reach. Runs nightly + on merge + on dispatch, non-blocking.

**Architecture:** A Tier-2 orchestrator creates a dedicated k3d cluster (`librepod-k3d-e2d`) from a lean config that auto-deploys Flux via the repo's existing bootstrap files and syncs `clusters/librepod-k3d`. Flux deploys the full system-apps chain including `marketplace-ui` (from the published, cosign-signed `:latest` image). The orchestrator waits for the Deployment, `kubectl port-forward`s it to `localhost:3000`, and Playwright drives the live app. Tests assert the real Flux reconcile loop (status transitions to `running`).

**Tech Stack:** Playwright (Chromium), k3d (`rancher/k3s`), FluxCD, kubectl, the existing NestJS+React marketplace, real Gogs + signed OCI artifacts from GHCR.

## Global Constraints (Tier 2)

- **Inherits Plan 1's Global Constraints** (Node, commit hygiene, `data-testid`/role selectors, etc.).
- **Advisory only:** the `ui-e2e-cluster` check is **never** a required merge gate (too slow/flaky for per-PR).
- **Image strategy (diverges from spec §5.3):** test the Flux-deployed published image (`ghcr.io/librepod/marketplace-ui:latest`) by default — **no source-import, no Flux-suspend dance**. Rationale: Tier 2 triggers are `schedule`/`push: master`/`dispatch` (never PRs), so `:latest` IS master's code. Source-import remains available via `LIBREPOD_E2E_IMAGE=src` for manual PR-dispatch (documented, not implemented by default).
- **Cluster name:** `librepod-k3d-e2e` (distinct from the dev `librepod-k3d`) so Tier 2 never clobbers a developer's running cluster.
- **Tooling on PATH:** `k3d`, `flux`, `kubectl`, `curl` (provided by `shell.nix` after Task 1's R3 fix; installed in CI via the workflow).
- **Realistic, not hermetic:** pulls real signed OCI artifacts from GHCR (network + cosign verification) — inherent to testing the real supply chain (risk R5). Retries + nightly cadence absorb transient failures.
- **Generous timeouts:** Flux reconcile takes minutes; per-test timeout 300s; install→`running` poll up to 5 min.
- **App selection for the `running` assertion is empirical:** the reconcile test picks a user-facing app from `/api/apps`; override with `LIBREPOD_E2E_APP=<name>` if the default doesn't reconcile cleanly in k3d.

## File Structure

```
ui/packages/e2e/
├── support/
│   ├── k3d-e2e.config.yaml          # NEW — lean k3d cluster config (name librepod-k3d-e2e)
│   └── run-tier2.sh                 # NEW — orchestrator: k3d create → wait Flux → port-forward → playwright → delete
├── projects/
│   └── tier2.config.ts              # NEW — baseURL via port-forward, NO webServer, slow timeouts
└── tests/
    └── cluster-level/
        ├── cluster-smoke.spec.ts    # NEW — catalog renders against real Gogs/ConfigMap
        └── reconcile-lifecycle.spec.ts  # NEW — install→running, Open link, Uninstall dialog (deferred from Tier 1)
```

**Modified files:**
- `shell.nix` — add `kubectl`, `curl`, `jq` (R3).
- `ui/package.json` — add `test:e2e:ui:cluster` root shim.
- `ui/packages/e2e/package.json` — add `test:e2e:ui:cluster` script.
- `ui/CLAUDE.md` — document the Tier 2 command + the image-strategy divergence.

---

### Task 1: Lean k3d config + dev-shell tooling (R3)

**Files:**
- Create: `ui/packages/e2e/support/k3d-e2e.config.yaml`
- Modify: `shell.nix`

**Interfaces:**
- Produces: a portable k3d config that boots Flux (via the repo's 4 bootstrap files) syncing `clusters/librepod-k3d`, cluster name `librepod-k3d-e2e`. `shell.nix` now provides `kubectl`/`curl`/`jq` for the orchestrator.

- [ ] **Step 1: Create `ui/packages/e2e/support/k3d-e2e.config.yaml`**

A lean copy of the repo's `k3d-config.yaml`: distinct cluster name, no persistent-volume mapping (ephemeral storage is fine), no ingress/host port mappings (we use port-forward), keeps the 4 Flux bootstrap files + `--disable=traefik`.

```yaml
# k3d config for the Tier 2 e2e cluster. Distinct name so it never clobbers the dev cluster.
# Usage: k3d cluster create --config packages/e2e/support/k3d-e2e.config.yaml
apiVersion: k3d.io/v1alpha5
kind: Simple
metadata:
  name: librepod-k3d-e2e
servers: 1
image: rancher/k3s:v1.34.3-k3s1

# No volumes: mapping — ephemeral storage is fine for an e2e cluster.

files:
  - source: clusters/librepod-k3d/bootstrap/cosign-pub.yaml
    destination: /var/lib/rancher/k3s/server/manifests/custom/cosign-pub.yaml
    nodeFilters: ["server:*"]
  - source: clusters/librepod-k3d/bootstrap/nfs-client-storageclass.yaml
    destination: /var/lib/rancher/k3s/server/manifests/custom/nfs-client-storageclass.yaml
    nodeFilters: ["server:*"]
  - source: clusters/librepod-k3d/bootstrap/flux-operator.yaml
    destination: /var/lib/rancher/k3s/server/manifests/custom/flux-operator.yaml
    nodeFilters: ["server:*"]
  - source: clusters/librepod-k3d/bootstrap/flux-instance.yaml
    destination: /var/lib/rancher/k3s/server/manifests/custom/flux-instance.yaml
    nodeFilters: ["server:*"]

options:
  k3d:
    wait: true
    timeout: "120s"
  k3s:
    extraArgs:
      - arg: --disable=traefik
        nodeFilters: ["server:*"]
  kubeconfig:
    updateDefaultKubeconfig: true
    switchCurrentContext: true
```

> **Path note:** `source` paths are relative to the cwd where `k3d cluster create` runs. The orchestrator (Task 2) runs from the **repo root**, so `clusters/librepod-k3d/bootstrap/...` resolves. `flux-instance.yaml` hardcodes `path=./clusters/librepod-k3d` — that path is *inside the bootstrap OCI artifact*, independent of this k3d cluster's name, so it still syncs correctly.

- [ ] **Step 2: Add `kubectl`, `curl`, `jq` to `shell.nix`**

```nix
{ pkgs ? import <nixpkgs> {}}:

pkgs.mkShell {
  packages = [
    pkgs.fluxcd
    pkgs.just
    pkgs.k3d
    pkgs.go
    pkgs.kustomize
    pkgs.kubernetes-helm
    pkgs.kubectl
    pkgs.curl
    pkgs.jq
  ];
}
```

- [ ] **Step 3: Verify the shell provides the tools**

Run (from repo root): `nix-shell shell.nix --run "kubectl version --client && curl --version | head -1 && jq --version && k3d version | head -1 && flux --version"`
Expected: each command prints its version (no "command not found").

- [ ] **Step 4: Commit**

```bash
git add ui/packages/e2e/support/k3d-e2e.config.yaml shell.nix
git commit -m "test(e2e): add Tier 2 k3d cluster config; add kubectl/curl/jq to dev shell"
```

---

### Task 2: Tier 2 Playwright config + orchestrator + cluster smoke

**Files:**
- Create: `ui/packages/e2e/projects/tier2.config.ts`
- Create: `ui/packages/e2e/support/run-tier2.sh`
- Create: `ui/packages/e2e/tests/cluster-level/cluster-smoke.spec.ts`
- Modify: `ui/package.json`, `ui/packages/e2e/package.json`

**Interfaces:**
- Consumes: Plan 1's `playwright.config` base; the published marketplace-ui Deployment (`image: ghcr.io/librepod/marketplace-ui:latest`, Service `marketplace-ui:80` in ns `marketplace-ui`, health at `/api/health`).
- Produces: `npm run test:e2e:ui:cluster` that boots the cluster and runs the smoke test against the live deployment.

- [ ] **Step 1: Create `ui/packages/e2e/projects/tier2.config.ts`**

```ts
import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

// No webServer — the app runs in the k3d cluster, reached via kubectl port-forward
// (orchestrator maps localhost:3000 → svc/marketplace-ui:80).
export default defineConfig({
  ...base,
  testDir: "../tests/cluster-level",
  timeout: 300_000, // cluster tests are slow (Flux reconcile)
  use: {
    ...base.use,
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
  },
});
```

- [ ] **Step 2: Create `ui/packages/e2e/support/run-tier2.sh`**

```bash
#!/usr/bin/env bash
# Tier 2 orchestrator: k3d create → wait Flux + marketplace-ui → port-forward → Playwright → delete.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
E2E="$REPO_ROOT/packages/e2e"
CLUSTER="${LIBREPOD_E2E_CLUSTER:-librepod-k3d-e2e}"
NS="marketplace-ui"
PF_PORT="${LIBREPOD_E2E_PORT:-3000}"
PF_PID=""

cleanup() {
  echo "Tearing down..."
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$REPO_ROOT"

echo "==> Creating k3d cluster $CLUSTER (Flux will bootstrap ~5-10 min)"
k3d cluster create --config "$E2E/support/k3d-e2e.config.yaml"

echo "==> Waiting for marketplace-ui Deployment to be deployed by Flux"
for i in $(seq 1 150); do  # up to ~12 min
  if kubectl get deployment marketplace-ui -n "$NS" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done
kubectl rollout status deployment/marketplace-ui -n "$NS" --timeout=600s

echo "==> Port-forwarding marketplace-ui → localhost:$PF_PORT"
kubectl port-forward svc/marketplace-ui -n "$NS" "${PF_PORT}:80" >/dev/null 2>&1 &
PF_PID=$!
for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:${PF_PORT}/api/health" >/dev/null && break || sleep 2
done

echo "==> Running Playwright (Tier 2)"
cd "$E2E"
E2E_BASE_URL="http://localhost:${PF_PORT}" exec npx playwright test --config projects/tier2.config.ts "$@"
```

> **`exec` + trap:** `exec` replaces the shell with Playwright so its exit code propagates; the `trap` was already registered, and `k3d cluster delete` runs via the subshell's EXIT. If `exec` interferes with the trap on your shell version, drop `exec` and rely on the last-command exit code. Make executable: `chmod +x ui/packages/e2e/support/run-tier2.sh`.

- [ ] **Step 3: Wire the scripts**

In `ui/packages/e2e/package.json`, add to `scripts`:
```json
"test:e2e:ui:cluster": "bash support/run-tier2.sh"
```

In `ui/package.json`, add to `scripts`:
```jsonc
"test:e2e:ui:cluster": "npm run test:e2e:ui:cluster --workspace=packages/e2e",
```

- [ ] **Step 4: Write the cluster smoke spec**

Create `ui/packages/e2e/tests/cluster-level/cluster-smoke.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

// Validates the in-cluster deployment: real Gogs, real catalog ConfigMap, live API.
test("catalog renders against the live cluster", async ({ page, request }) => {
  const body = await (await request.get("/api/apps")).json();
  expect(Array.isArray(body.apps)).toBeTruthy();
  expect(body.apps.length).toBeGreaterThan(0);
  // Server filters out Infrastructure apps.
  expect(body.apps.every((a: { category: string }) => a.category !== "Infrastructure")).toBeTruthy();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "LibrePod", level: 1 })).toBeVisible();
  const firstName = body.apps[0].displayName;
  await expect(page.getByRole("link", { name: firstName })).toBeVisible();
});
```

- [ ] **Step 5: Run the orchestrator (first cluster boot)**

Run (from repo root, inside `nix-shell`): `npm --prefix ui run test:e2e:ui:cluster`
Expected: k3d cluster creates, Flux bootstraps (~5–10 min), `marketplace-ui` Deployment rolls out, port-forward succeeds, the smoke test passes (catalog returns real user-facing apps, header + first card render). If the Deployment never appears, inspect Flux: `flux get kustomizations -n flux-system`, `flux logs -n flux-system`. If a system app is stuck, that's a real-bootstrap issue beyond this plan — note it and retry (nightly cadence tolerates transient failures).

- [ ] **Step 6: Commit**

```bash
git add ui/packages/e2e/projects/tier2.config.ts ui/packages/e2e/support/run-tier2.sh ui/packages/e2e/tests/cluster-level/cluster-smoke.spec.ts ui/package.json ui/packages/e2e/package.json
git commit -m "test(e2e): add Tier 2 k3d orchestrator + cluster smoke test"
```

---

### Task 3: Reconcile-lifecycle spec (the flows Tier 1 can't reach)

**Files:**
- Create: `ui/packages/e2e/tests/cluster-level/reconcile-lifecycle.spec.ts`

**Interfaces:**
- Consumes: `AppDetailPage` (Plan 1 Task 5) — including the deferred `uninstallButton()`, `confirmUninstall()`, `keepApp()` methods. Real Flux reconcile: install commits to Gogs → `user-apps-source` GitRepository polls → reconciles the app → Flux CRD with label `marketplace.io/app=<name>` reaches `Ready=True` → `FluxStatusService` reports `running`.

- [ ] **Step 1: Write the reconcile-lifecycle spec**

```ts
import { test, expect, type APIRequestContext } from "@playwright/test";
import { AppDetailPage } from "../../support/pages/AppDetailPage";

// Picks the app to install: LIBREPOD_E2E_APP override, else the first user-facing app.
async function pickApp(request: APIRequestContext): Promise<string> {
  if (process.env.LIBREPOD_E2E_APP) return process.env.LIBREPOD_E2E_APP;
  const body = await (await request.get("/api/apps")).json();
  return body.apps[0].name;
}

test.describe("cluster reconcile lifecycle (real Flux)", () => {
  test("install reconciles to Running", async ({ page, request }) => {
    const name = await pickApp(request);
    const detail = new AppDetailPage(page);
    await detail.open(name);
    await expect(detail.installButton()).toBeVisible();
    await detail.installButton().click();

    // Gogs commit → user-apps-source poll → reconcile → CRD Ready → "running". Allow up to 5 min.
    await expect.poll(
      async () =>
        (await (await request.get(`/api/apps/${name}`)).json()).apps?.[0]?.installedStatus,
      { message: `${name} reaches Running`, timeout: 300_000, intervals: [5_000] },
    ).toBe("running");

    await detail.open(name);
    await expect(detail.statusBadge()).toHaveText(/Running/);
  });

  test("at Running: the Open link targets the base domain", async ({ page, request }) => {
    const body = await (await request.get("/api/apps")).json();
    const running = body.apps.find((a: { installedStatus: string }) => a.installedStatus === "running");
    test.skip(!running, "no app is currently Running");
    const cfg = await (await request.get("/api/config")).json();

    const detail = new AppDetailPage(page);
    await detail.open(running.name);
    // "Open {displayName}" — rendered as an anchor. Try role "link"; fall back to "button".
    const openLink = page.getByRole("link", { name: new RegExp(`^Open ${running.displayName}`) });
    await expect(openLink.or(page.getByRole("button", { name: new RegExp(`^Open ${running.displayName}`) }))).toHaveAttribute(
      "href",
      `https://${running.name}.${cfg.baseDomain}`,
    );
  });

  test("uninstall dialog (reachable at Running) removes the app", async ({ page, request }) => {
    const body = await (await request.get("/api/apps")).json();
    const running = body.apps.find((a: { installedStatus: string }) => a.installedStatus === "running");
    test.skip(!running, "no app is currently Running");
    const detail = new AppDetailPage(page);
    await detail.open(running.name);

    // status running → Uninstall action is present.
    await detail.uninstallButton().click();
    await expect(page.getByRole("alertdialog")).toBeVisible();

    // "Keep App" cancels and leaves the app installed.
    await detail.keepApp().click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);

    // Re-open and confirm.
    await detail.uninstallButton().click();
    await detail.confirmUninstall();

    // Flux prunes; status returns to not_installed (root kustomization entry removed).
    await expect.poll(
      async () =>
        (await (await request.get(`/api/apps/${running.name}`)).json()).apps?.[0]?.installedStatus,
      { message: `${running.name} leaves installed set`, timeout: 180_000, intervals: [5_000] },
    ).toBe("not_installed");
  });
});
```

> **Implementer notes:**
> - These three tests share state (the first installs; the others act on a `running` app). Playwright runs them in file order; keep the order. For independence, add a `beforeAll`/`afterAll` that ensures one app is installed/running.
> - The `Open` link is `<Button render={<a/>}>` (base-ui) — its role may be `link` or `button`; the `.or()` covers both. Confirm via the run; simplify to the matching role once observed.
> - If the default app never reaches `running` (k3d reconcile issue for that specific app), set `LIBREPOD_E2E_APP=<lightweight-app>` to one that deploys cleanly.

- [ ] **Step 2: Run the spec**

Run (from repo root, inside `nix-shell`): `npm --prefix ui run test:e2e:ui:cluster -- tests/cluster-level/reconcile-lifecycle.spec.ts`
Expected: install test passes (app transitions to `running` within ~5 min); Open-link test passes (href matches `https://<name>.<baseDomain>`); uninstall-dialog test passes (Keep App cancels; confirm → status returns to `not_installed`). If the app doesn't reach `running`, see the implementer notes.

- [ ] **Step 3: Commit**

```bash
git add ui/packages/e2e/tests/cluster-level/reconcile-lifecycle.spec.ts
git commit -m "test(e2e): cover full Flux reconcile lifecycle + Uninstall dialog + Open link"
```

---

### Task 4: CI workflow (advisory: nightly + on-merge + dispatch)

**Files:**
- Create: `.github/workflows/ui-e2e-cluster.yaml`

**Interfaces:**
- Consumes: `npm run test:e2e:ui:cluster` (Task 2); k3d/flux installed on the runner.

- [ ] **Step 1: Create `.github/workflows/ui-e2e-cluster.yaml`**

```yaml
name: ui-e2e-cluster

on:
  schedule:
    - cron: "37 3 * * *" # nightly ~03:37 UTC (off the hour)
  push:
    branches: [master]
    paths:
      - "ui/**"
      - "apps/marketplace-ui/**"
      - "clusters/librepod-k3d/**"
      - ".github/workflows/ui-e2e-cluster.yaml"
  workflow_dispatch:

jobs:
  tier2:
    name: Tier 2 (k3d cluster, realistic)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: ui/package-lock.json

      - name: Install k3d and flux
        run: |
          curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
          curl -sSfL https://fluxcd.io/install.sh | sh
          # kubectl is preinstalled on ubuntu-latest

      - name: Install dependencies
        working-directory: ui
        run: npm ci

      - name: Install Playwright browser
        working-directory: ui
        run: npx playwright install --with-deps chromium

      - name: Run Tier 2 e2e
        working-directory: ui
        run: npm run test:e2e:ui:cluster

      - name: Upload Playwright report
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report-cluster
          path: ui/packages/e2e/playwright-report
          retention-days: 14

      - name: Upload test results (traces/screenshots)
        if: ${{ failure() }}
        uses: actions/upload-artifact@v4
        with:
          name: playwright-test-results-cluster
          path: ui/packages/e2e/test-results
          retention-days: 7
```

- [ ] **Step 2: Validate the workflow file**

Run (from repo root): `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ui-e2e-cluster.yaml')); print('valid')"` (or `npx --yes js-yaml .github/workflows/ui-e2e-cluster.yaml >/dev/null && echo valid`).
Expected: prints `valid`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ui-e2e-cluster.yaml
git commit -m "ci(ui): add advisory Tier 2 e2e workflow (nightly + on-merge + dispatch)"
```

> **Gating note:** do **not** add `ui-e2e-cluster` as a required check — it's intentionally advisory (slow, real-network-dependent). Its status is visible on commits/PRs as a signal, never a blocker.

---

### Task 5: Documentation

**Files:**
- Modify: `ui/CLAUDE.md`

**Interfaces:**
- None (docs).

- [ ] **Step 1: Extend the E2E section in `ui/CLAUDE.md`**

Append to the "### E2E (browser, Playwright)" subsection added by Plan 1:

````markdown
**Tier 2 — realistic, in a local k3d cluster (nightly/advisory):**

```bash
npm run test:e2e:ui:cluster          # k3d create → Flux bootstrap → port-forward → Playwright → delete
```

- Boots a dedicated `librepod-k3d-e2e` cluster (config: `packages/e2e/support/k3d-e2e.config.yaml`)
  that syncs `clusters/librepod-k3d` via Flux — the full system-apps chain + the published
  `marketplace-ui` image. Reached via `kubectl port-forward` (HTTP, no ingress).
- Asserts the **full GitOps lifecycle** Tier 1 can't: install → Flux reconcile → `running`;
  the Uninstall `AlertDialog`; the "Open {app}" link. These need `running`/`error` status,
  reachable only with a cluster.
- Tests the **published** image (`:latest`), not a source build — Tier 2 runs on master/nightly
  (never PRs), so `:latest` IS master's code. For manual PR-dispatch, set `LIBREPOD_E2E_IMAGE=src`
  (documented, not the default) to build + `k3d image import` + suspend the marketplace-ui
  kustomization first.
- Advisory CI: `.github/workflows/ui-e2e-cluster.yaml` (nightly + push to master + dispatch).
  Never a required check.
- Needs `k3d`, `flux`, `kubectl`, `curl` on PATH (provided by `shell.nix`; installed in CI).
- Override the app used for the `running` assertion with `LIBREPOD_E2E_APP=<name>`.
````

- [ ] **Step 2: Commit**

```bash
git add ui/CLAUDE.md
git commit -m "docs(ui): document the Tier 2 k3d cluster e2e suite"
```

---

## Self-Review

**Spec coverage** (against `docs/marketplace-ui-e2e-design.md`):
- §2 Goal 3 (deployment-level realism, off critical path): Tasks 2, 3. ✅
- §5.3 Tier 2 lifecycle (k3d bootstrap reuse → port-forward → reconcile-to-running): Tasks 1, 2. ✅
- §5.3 reconcile-to-running + pruning assertions: Task 3. ✅
- §5.4 reuses shared core (POM, base config): consumes Plan 1 artifacts. ✅
- §6 Tier 2 inventory (cluster-smoke + reconcile-lifecycle): Tasks 2, 3. ✅
- §6 deferred UI flows (Uninstall `AlertDialog`, "Open" link — moved from Tier 1): Task 3. ✅
- §8 CI workflow (Tier 2 advisory, nightly/on-merge/dispatch): Task 4. ✅
- §9 R3 (`shell.nix` lacks kubectl): Task 1. ✅
- §9 R2 (`k3d-config.yaml` stale volume path): **downgraded** — Tier 2 sidesteps it entirely by using its own lean config with no persistent-volume mapping. The shared dev `k3d-config.yaml`'s stale path remains a separate dev bug to fix independently (noted, not blocking).
- §9 R4/R5 (boot time + cosign/network flakiness): absorbed by advisory nightly cadence + retries (base config) + generous timeouts. ✅

**Divergence from spec §5.3 (intentional):** spec chose source-import for the image; this plan tests the **published `:latest`** by default. Rationale: Tier 2's triggers (`schedule`/`push: master`/`dispatch`, never PRs) mean `:latest` is already master's code, and avoiding the image-swap removes a fragile `flux suspend` + `k3d image import` + `imagePullPolicy` patch sequence. Source-import remains documented as a `LIBREPOD_E2E_IMAGE=src` escape hatch.

**Placeholder scan:** empirical points (app reaching `running`, `Open`-link role, `exec`+trap interaction) each carry a concrete verification step + fallback (env override / `.or()` locator / drop-`exec`). No TBD/TODO.

**Type consistency:** `AppDetailPage.open/.installButton/.uninstallButton/.confirmUninstall/.keepApp/.statusBadge` match the definitions in Plan 1 Task 5; `pickApp`/`running.name`/`cfg.baseDomain` used consistently. `APIRequestContext` imported for the helper signature.
