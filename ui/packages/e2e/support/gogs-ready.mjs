// Waits for Gogs, then verifies the seeded state is usable by the marketplace
// server: (1) the token bootstrap (Basic auth flux:<password>) works exactly
// as GogsService.onModuleInit does it, and (2) the root kustomization.yaml in
// flux/user-apps is readable and in the clean empty state (resources: []).
// Exits 0 only when the server can install against this Gogs.
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

await waitForGogs();
console.log("Gogs is responding. Verifying seeded state...");

const token = await bootstrapToken();
const kr = await fetch(
  `${GOGS_URL}/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml`,
  { headers: { Authorization: `token ${token}` } },
);
if (!kr.ok) throw new Error(`root kustomization read failed: ${kr.status}`);
const body = await kr.text();
if (!/resources:\s*\[\s*\]/.test(body))
  throw new Error(`root kustomization not in expected empty state:\n${body}`);

console.log("Gogs ready: token bootstrap OK, flux/user-apps root kustomization verified.");
