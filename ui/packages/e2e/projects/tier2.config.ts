import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

// No webServer — the app runs in the k3d cluster, reached via kubectl port-forward
// (orchestrator maps localhost:<PF_PORT> → svc/marketplace-ui:80).
//
// Serial execution (workers:1, fullyParallel:false): the reconcile tests share ONE
// cluster — the first installs and waits for Running; the Open/uninstall tests then
// act on that Running app. Same shared-state reason Tier 1 serialized on Gogs.
//
// The default baseURL matches run-tier2.sh's PF_PORT default (3101, not 3000 — see
// the orchestrator for why a stray dev server rules out 3000). E2E_BASE_URL always
// wins, so the orchestrator's explicit export takes precedence in normal runs; this
// fallback just keeps a direct `playwright test --config ...` invocation pointed at
// the same port the orchestrator would use.
export default defineConfig({
  ...base,
  testDir: "../tests/cluster-level",
  timeout: 300_000, // cluster tests are slow (real Flux reconcile)
  fullyParallel: false,
  workers: 1,
  use: {
    ...base.use,
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3101",
  },
});
