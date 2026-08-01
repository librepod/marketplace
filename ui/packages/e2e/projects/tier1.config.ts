import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

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

export default defineConfig({
  ...base,
  fullyParallel: false,
  workers: 1,
  testDir: "../tests/app-level",
  use: {
    ...base.use,
    baseURL: ORIGIN,
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
    },
    url: `${ORIGIN}/api/health`,
    reuseExistingServer: false, // always start a server matching the fresh build
    timeout: 60_000,
  },
});
