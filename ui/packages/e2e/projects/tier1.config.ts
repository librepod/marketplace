import { defineConfig } from "@playwright/test";
import base from "../playwright.config";
import { sessionStorageState } from "../support/mint-session";

// Tier 1 shares a single seeded Gogs across specs, so an install in one spec
// mutates state another spec reads. Serialize (workers: 1) to avoid races.
//
// Spread process.env so the spawned `node` keeps PATH, but explicitly drop
// KUBERNETES_SERVICE_HOST: with no cluster, FluxStatusService must degrade to
// "installing" rather than trying an inherited in-cluster config (design C2).
//
// Port 3100 (not 3000) avoids colliding with a developer's running server on
// the conventional port; reuseExistingServer:false means Playwright refuses to
// test a server it didn't start, so the gate always exercises a fresh build.
const serverEnv: NodeJS.ProcessEnv = { ...process.env };
delete serverEnv.KUBERNETES_SERVICE_HOST;

const PORT = "3100";
const ORIGIN = `http://localhost:${PORT}`;

// Tier 1 is hermetic — no Casdoor — so tests can't log in through the UI. The
// marketplace server now requires a session (AuthGuard gates /api/* and the SPA
// hides behind AuthGate). We satisfy that two ways, both using a STUB identity:
//
//   1. webServer.env sets SESSION_SECRET + CASDOOR_* stubs so the server BOOTS
//      (SessionService refuses the committed default secret; CasdoorService
//      fails fast on missing env). Stubs are fine — Tier 1 never calls Casdoor.
//   2. A REAL session cookie is minted with the same HMAC + secret
//      SessionService uses, and injected via storageState. That authenticates
//      both the `page` (SPA/AuthGate) and `request` (/api/apps) fixtures,
//      exercising the actual AuthGuard verify path — no test-hook in auth code.
//      NB: the HMAC lives in support/mint-session.ts; it must stay in sync
//      with SessionService.sign/verify.
const SESSION_SECRET = "tier1-e2e-session-secret-not-for-prod";

export default defineConfig({
  ...base,
  fullyParallel: false,
  workers: 1,
  testDir: "../tests/app-level",
  use: {
    ...base.use,
    baseURL: ORIGIN,
    storageState: sessionStorageState(SESSION_SECRET, "localhost"),
  },
  webServer: {
    // The orchestrator already built client+server; this just serves the
    // prod-like app (Nest serves the built SPA + the API on :3100).
    command: "node packages/server/dist/main.js",
    cwd: process.cwd(),
    env: {
      ...serverEnv,
      PORT,
      CATALOG_PATH: `${process.cwd()}/packages/e2e/fixtures/catalog.fixture.yaml`,
      GOGS_URL: "http://127.0.0.1:43000",
      GOGS_USERNAME: "flux",
      GOGS_TOKEN: "pass@w0rd", // NB: used as the Basic-auth PASSWORD by GogsService
      BASE_DOMAIN: "libre.pod",
      ALLOWED_ORIGINS: ORIGIN,
      // Auth boot deps (stubs — the minted session cookie authenticates tests;
      // Tier 1 never reaches Casdoor).
      SESSION_SECRET,
      CASDOOR_ENDPOINT: "https://id.example.com",
      CASDOOR_CLIENT_ID: "marketplace-ui",
      CASDOOR_CLIENT_SECRET: "e2e-stub-secret",
      CASDOOR_ORG_NAME: "librepod",
      CASDOOR_APP_NAME: "marketplace-ui",
      // Force FluxStatusService to degrade to "installing" deterministically:
      // point KUBECONFIG at a closed port (see support/kubeconfig.closed.yaml)
      // so the k8s call ECONNREFUSES instead of querying the host's real cluster.
      KUBECONFIG: `${process.cwd()}/packages/e2e/support/kubeconfig.closed.yaml`,
      // Test seam: mark `frp-operator` as a managed platform app for this run,
      // so the Platform panel + /api/system-apps + the install 409 can be
      // exercised hermetically (no real system-apps Kustomization in Tier 1).
      // `frp-operator` (not `gogs`): the other app-level specs assert that
      // `gogs` is a normal user-facing app, so reusing it here would filter it
      // out of /api/apps and break smoke/catalog specs. frp-operator is a
      // dedicated fixture app no other spec asserts on.
      SYSTEM_APPS_OVERRIDE: JSON.stringify([
        { name: "frp-operator", kustomization: "frp-operator" },
      ]),
    },
    url: `${ORIGIN}/api/health`,
    reuseExistingServer: false, // always start a server matching the fresh build
    timeout: 60_000,
  },
});
