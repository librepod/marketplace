import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

/**
 * #182's acceptance criterion, executable: ONE broken app must not turn any
 * shared Flux object Ready=False.
 *
 * THE BREAK IS DECLARATIVE — committed to the app-store repo, never patched onto
 * the live object. A `kubectl patch` of the app's OCIRepository is reverted by
 * kustomize-controller's drift correction within one `user-apps` interval (1m,
 * assumed, NOT live-probed), so a patch-based version of this test races its own
 * assertions and
 * flakes. Committing the break makes it the DESIRED state: Flux enforces it
 * instead of healing it. It also exercises the new "presence in the repo IS the
 * declaration" contract, which is the other half of #182.
 *
 * The probe app is synthetic and absent from the catalog, so `enrich()` never
 * surfaces it and no other spec can observe it — which is also why it does not
 * collide with `reconcile-lifecycle.spec.ts`'s `pickApp()` app the way breaking a
 * real app would. Nothing to clean up: this gogs release has no DELETE route
 * (live-probed, #182) and `run-tier2.sh` destroys the cluster — and with it the in-cluster
 * Gogs — at the end of the run.
 */
const APP = "broken-probe-182";
const NS = "marketplace-ui";

function kubectl(args: string[]): string {
  return execFileSync("kubectl", args, { encoding: "utf8" });
}

/** Strict: throws if the object is missing. Use for the real assertions. */
function ready(kind: string, name: string): string {
  return kubectl([
    "get", kind, name, "-n", "flux-system",
    "-o", 'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
  ]).trim();
}

/** Tolerant: "absent" until Flux has applied it. Use only inside expect.poll. */
function readyOrAbsent(kind: string, name: string): string {
  try {
    return ready(kind, name);
  } catch {
    return "absent";
  }
}

/**
 * Valid YAML that applies cleanly and can never become Ready: the OCI tag does not
 * exist, so the OCIRepository never produces an artifact. Keeping the YAML VALID is
 * essential — malformed YAML fails the whole-tree build (#182) and would turn
 * `user-apps` Ready=False, destroying this test's premise instead of testing it.
 */
function brokenAppFiles(): Record<string, string> {
  const meta = (kind: string, apiVersion: string) => [
    `apiVersion: ${apiVersion}`,
    `kind: ${kind}`,
    "metadata:",
    `  name: marketplace-${APP}`,
    "  namespace: flux-system",
    "  labels:",
    `    marketplace.io/app: ${APP}`,
  ];
  return {
    [`apps/${APP}/source.yaml`]: [
      ...meta("OCIRepository", "source.toolkit.fluxcd.io/v1"),
      "spec:",
      "  interval: 1m",
      "  url: oci://ghcr.io/librepod/marketplace/apps/whoami",
      "  ref:",
      '    tag: "0.0.0-does-not-exist"',
      "",
    ].join("\n"),
    [`apps/${APP}/release.yaml`]: [
      ...meta("Kustomization", "kustomize.toolkit.fluxcd.io/v1"),
      "spec:",
      "  interval: 1m",
      "  retryInterval: 1m",
      "  timeout: 2m",
      "  sourceRef:",
      "    kind: OCIRepository",
      `    name: marketplace-${APP}`,
      "  path: ./overlays/librepod",
      "  prune: true",
      "  wait: true",
      "",
    ].join("\n"),
    [`apps/${APP}/kustomization.yaml`]: [
      "apiVersion: kustomize.config.k8s.io/v1beta1",
      "kind: Kustomization",
      "resources:",
      "  - source.yaml",
      "  - release.yaml",
      "",
    ].join("\n"),
  };
}

/**
 * Commit `apps/<APP>/` through the Gogs contents API, executed from INSIDE the
 * server pod — the same route `run-tier2.sh`'s diagnostics take, and the only one
 * with both the credential and in-cluster DNS. PUT to a path that does not exist
 * creates it (201), so no `sha` read-modify-write is needed. Basic auth mints the
 * token; contents needs `token <sha1>` (the #180 auth matrix).
 */
function commitBrokenApp(): void {
  const pod = kubectl([
    "get", "pods", "-n", NS, "-l", "app.kubernetes.io/name=marketplace-ui",
    "-o", "jsonpath={.items[0].metadata.name}",
  ]).trim();

  const script = `
    const { readFileSync } = require('node:fs');
    const dir = process.env.USER_APPS_GIT_CREDENTIALS_DIR || '/etc/user-apps-git';
    const u = readFileSync(dir + '/username', 'utf8').trim();
    const p = readFileSync(dir + '/password', 'utf8').trim();
    const G = 'http://gogs.gogs.svc.cluster.local.:80';
    const files = ${JSON.stringify(brokenAppFiles())};
    (async () => {
      const t = await fetch(G + '/api/v1/users/' + u + '/tokens', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(u + ':' + p).toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'broken-probe-' + process.pid }),
      });
      if (!t.ok) throw new Error('token mint -> ' + t.status);
      const tok = (await t.json()).sha1;
      for (const [path, content] of Object.entries(files)) {
        const r = await fetch(G + '/api/v1/repos/' + u + '/user-apps/contents/' + path, {
          method: 'PUT',
          headers: { Authorization: 'token ' + tok, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'test: plant a deliberately broken app (#182)',
            content: Buffer.from(content).toString('base64'),
          }),
        });
        if (!r.ok) throw new Error('PUT ' + path + ' -> ' + r.status);
      }
      console.log('planted');
    })().catch((e) => { console.error(e.message); process.exit(1); });
  `;

  expect(
    kubectl(["exec", "-n", NS, pod, "-c", "marketplace-ui", "--", "node", "-e", script]),
  ).toContain("planted");
}

test.describe("broken-app isolation (#182)", () => {
  // Longer than the other cluster specs: it deliberately waits out two `user-apps`
  // reconciles to prove the break is stable rather than racing drift correction.
  test.describe.configure({ retries: 0, timeout: 900_000 });

  test("a broken app degrades alone; the shared objects and the UI stay Ready", async ({ request }) => {
    commitBrokenApp();

    await expect.poll(() => readyOrAbsent("kustomization", `marketplace-${APP}`), {
      message: `marketplace-${APP} is applied and goes Ready=False`,
      timeout: 300_000,
      intervals: [10_000],
    }).toBe("False");

    // STABILITY, not a snapshot. `user-apps` reconciles every 1m; surviving ~2.5
    // intervals proves Flux is enforcing the broken state, not healing it. If this
    // assertion ever fails, the break mechanism has regressed to something Flux
    // overwrites — which is exactly the flake this test was rewritten to remove.
    await new Promise((resolve) => setTimeout(resolve, 150_000));
    expect(ready("kustomization", `marketplace-${APP}`)).toBe("False");

    // The whole point: nothing shared degraded with it.
    expect(ready("kustomization", "user-apps-source")).toBe("True");
    expect(ready("kustomization", "user-apps")).toBe("True");
    expect(ready("kustomization", "marketplace-ui")).toBe("True");

    // And the installer UI is still serving — the tool you need to remove it.
    // (That removal itself is covered by Tier 1's uninstall test and by
    // reconcile-lifecycle; asserting it here would mutate state those specs share.)
    expect((await request.get("/api/apps")).ok()).toBeTruthy();
    expect((await request.get("/api/installed")).ok()).toBeTruthy();
  });
});
