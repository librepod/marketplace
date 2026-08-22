import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Password URL-encoded (`@` → %40) exactly as support/gogs/seed.sh does it.
const ORIGIN = "http://flux:pass%40w0rd@127.0.0.1:43000/flux/user-apps.git";

/**
 * The repo's full file list, read over git.
 *
 * NOT via the Gogs tree API: this release IGNORES `?recursive=1` and returns only
 * the top level, so `apps/vaultwarden/release.yaml` would show up as a bare `apps`
 * entry and every path assertion below would be vacuous. Cloning also reads the
 * repo the same way Flux and the installer do, over the same http transport.
 */
function repoPaths(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "tier1-repo-layout-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--depth", "1", ORIGIN, dir], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return execFileSync("git", ["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.describe("app-store repo layout (#182)", () => {
  // Tier 1 shares one Gogs across specs (workers: 1), so an earlier spec can
  // leave vaultwarden installed. Same clean-slate beforeAll as
  // install-uninstall.spec.ts — this file asserts on exact repo contents, so it
  // must own its starting state rather than inherit file-order luck.
  test.beforeAll(async ({ request }) => {
    const r = await request.get("/api/apps/vaultwarden");
    if (r.ok() && (await r.json()).installedStatus !== "not_installed") {
      await request.post("/api/apps/vaultwarden/uninstall");
    }
  });

  test("the server migrated the repo off the shared root kustomization at boot", async () => {
    const paths = repoPaths();

    expect(paths).not.toContain("kustomization.yaml");
    // the orphan the seed planted (not in the old resources[] list) is gone
    expect(paths.filter((p) => p.startsWith("apps/orphan-probe"))).toEqual([]);
    expect(paths).toContain("README.md");
  });

  test("install writes only the app's own directory; uninstall deletes it", async ({ request }) => {
    expect(repoPaths().filter((p) => p.startsWith("apps/vaultwarden"))).toEqual([]);

    const install = await request.post("/api/apps/vaultwarden/install");
    expect(install.ok()).toBeTruthy();

    const after = repoPaths();
    expect(after).toContain("apps/vaultwarden/release.yaml");
    expect(after).toContain("apps/vaultwarden/source.yaml");
    expect(after).not.toContain("kustomization.yaml"); // no shared root file
    // Only vaultwarden's own directory was touched.
    expect(after.filter((p) => p.startsWith("apps/") && !p.startsWith("apps/vaultwarden/")))
      .toEqual([]);

    const uninstall = await request.post("/api/apps/vaultwarden/uninstall");
    expect(uninstall.ok()).toBeTruthy();

    // The pre-#182 uninstall only edited the root file and LEFT these files
    // behind (the provider API cannot delete). They must be gone now.
    expect(repoPaths().filter((p) => p.startsWith("apps/vaultwarden"))).toEqual([]);
  });
});
