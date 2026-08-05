import { defineConfig } from "@playwright/test";
import base from "../playwright.config";
import { sessionStorageState } from "../support/mint-session";

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
//
// Auth: since #51 the global AuthGuard gates every /api/* route (and the SPA behind
// AuthGate) on a valid `mp_session` cookie. The cluster's marketplace-ui verifies
// against a RANDOM SESSION_SECRET (Secret/marketplace-ui-session, minted by the
// bootstrap-session Job) the test runner can't predict — so unlike Tier 1 (which
// controls both signing and verifying with a stub secret), run-tier2.sh reads that
// live secret and exports it as E2E_SESSION_SECRET. We then mint a stateless HMAC
// cookie (support/mint-session.ts, same algorithm as SessionService.sign) and inject
// it via storageState, authenticating both the `page` (SPA + install/uninstall
// clicks) and `request` (/api/apps) fixtures. Without this every /api call 401s.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3101";
const sessionSecret = process.env.E2E_SESSION_SECRET;
if (!sessionSecret) {
  throw new Error(
    "E2E_SESSION_SECRET is required for Tier 2 — run via support/run-tier2.sh, " +
      "which reads it from Secret/marketplace-ui-session (key 'session-secret').",
  );
}
// Cookie domain must match the baseURL HOSTNAME (cookies ignore the port); a
// mismatch silently drops the cookie and every /api call 401s.
const baseURLHost = new URL(baseURL).hostname;

export default defineConfig({
  ...base,
  testDir: "../tests/cluster-level",
  timeout: 300_000, // cluster tests are slow (real Flux reconcile)
  fullyParallel: false,
  workers: 1,
  use: {
    ...base.use,
    baseURL,
    storageState: sessionStorageState(sessionSecret, baseURLHost),
  },
});
