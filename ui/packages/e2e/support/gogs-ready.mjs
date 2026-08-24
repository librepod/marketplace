// Waits for Gogs AND for the seed (support/gogs/seed.sh, run as the gogs-seed
// compose service) to complete, then verifies the state the server expects to
// find: (1) the flux user authenticates, and (2) the root kustomization.yaml is
// present in the clean empty state (resources: []).
//
// (2) asserts the PRE-#182 layout ON PURPOSE. Tier 1 seeds the old shape so the
// server's boot-time migration has something to migrate; this gate confirms the
// seed got there, and tests/app-level/repo-layout.spec.ts then asserts the
// migration removed it. Do not "modernise" this check to expect the new layout —
// it runs BEFORE the server starts, so the old shape is the correct expectation.
//
// Polling matters: `docker compose up --wait` returns when the gogs service is
// healthy, which can be several seconds BEFORE the one-shot gogs-seed service
// finishes creating the user/repo/kustomization. So both the user-existence and
// kustomization checks retry until the seed catches up.
const GOGS_URL = process.env.GOGS_URL ?? "http://127.0.0.1:43000";
const USERNAME = process.env.GOGS_USERNAME ?? "flux";
// NB: GOGS_TOKEN is the seeded user's *password* (used for Basic auth here),
// not a bearer token — see marketplace-ui-e2e-design.md constraint C1.
const PASSWORD = process.env.GOGS_TOKEN ?? "pass@w0rd";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForGogs(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${GOGS_URL}/api/v1/version`);
      // Any HTTP response (even 403 under REQUIRE_SIGNIN_VIEW=true) means Gogs
      // is up and serving its API. Only network errors / 5xx mean "not ready".
      if (r.status < 500) return;
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

// Retry until the flux user exists (bootstrapToken succeeds). Failed attempts —
// user not yet created by gogs-seed — do NOT mint tokens, so this produces
// exactly one token once the user appears.
async function waitForUser(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await bootstrapToken();
    } catch (e) {
      lastErr = e;
      await sleep(1000);
    }
  }
  throw new Error(
    `flux user/token not reachable within ${timeoutMs}ms (gogs-seed may have failed): ${lastErr?.message ?? lastErr}`,
  );
}

// Retry the root-kustomization read until gogs-seed has pushed it in the clean
// empty state. Uses the token from waitForUser (the raw endpoint requires a
// token, not Basic, on this Gogs build).
async function waitForKustomization(token, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  const url = `${GOGS_URL}/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml`;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { headers: { Authorization: `token ${token}` } });
      if (!r.ok) throw new Error(`read failed: ${r.status}`);
      const body = await r.text();
      if (!/resources:\s*\[\s*\]/.test(body))
        throw new Error(`not in expected empty state:\n${body}`);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(1000);
    }
  }
  throw new Error(`root kustomization not seeded within ${timeoutMs}ms: ${lastErr?.message ?? lastErr}`);
}

await waitForGogs();
console.log("Gogs is responding. Waiting for seed to complete...");
const token = await waitForUser();
await waitForKustomization(token);
console.log("Gogs ready: token bootstrap OK, flux/user-apps root kustomization verified.");
