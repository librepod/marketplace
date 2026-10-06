import { test, expect, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDetailPage } from "../../support/pages/AppDetailPage";
import { AppShell } from "../../support/pages/AppShell";

// Dev-mode OpenBao from docker-compose.e2e.yml (root token = the OPENBAO_TOKEN seam).
const OPENBAO = "http://127.0.0.1:48200";
const OPENBAO_TOKEN = "tier1-e2e-root-token";
// Password URL-encoded (`@` → %40) exactly as support/gogs/seed.sh does it.
const GIT_ORIGIN = "http://flux:pass%40w0rd@127.0.0.1:43000/flux/user-apps.git";
const TOKEN = "tier1-secret-token-7f3a";
const PROXY = "http://proxy.lan:3128";

/** The renovate entry as stored in OpenBao, or undefined when there is none. */
async function storedSettings(request: APIRequestContext): Promise<Record<string, string> | undefined> {
  const res = await request.get(`${OPENBAO}/v1/secret/data/renovate`, {
    headers: { "X-Vault-Token": OPENBAO_TOKEN },
  });
  if (res.status() === 404) return undefined;
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data.data;
}

/** True when any committed file in the app-store repo contains `text` (read over git). */
function repoContains(text: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "tier1-settings-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--depth", "1", GIT_ORIGIN, dir], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    try {
      execFileSync("git", ["-C", dir, "grep", "--quiet", "--fixed-strings", text, "HEAD"]);
      return true;
    } catch {
      return false; // git grep exits 1 when nothing matches
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function installedNames(request: APIRequestContext): Promise<string[]> {
  const res = await request.get("/api/installed");
  return ((await res.json()) as { name: string }[]).map((a) => a.name);
}

async function uninstallRenovate(request: APIRequestContext): Promise<void> {
  const r = await request.get("/api/apps/renovate");
  if (r.ok() && (await r.json()).installedStatus !== "not_installed") {
    await request.post("/api/apps/renovate/uninstall");
  }
}

// Sequential flow on the shared Gogs + OpenBao: install via the dialog, then
// uninstall. Owns its clean slate both ways so other specs never see renovate.
test.describe("install with settings", () => {
  test.beforeAll(async ({ request }) => uninstallRenovate(request));
  test.afterAll(async ({ request }) => uninstallRenovate(request));

  test("asks the questions, stores the answers in OpenBao, never in git", async ({ page, request }) => {
    const detail = new AppDetailPage(page);
    const shell = new AppShell(page);
    await detail.open("renovate");
    await detail.installButton().click();

    const dialog = detail.installDialog();
    await expect(dialog.getByRole("heading", { name: "Install Renovate" })).toBeVisible();

    // The server validates: the required token is missing.
    await dialog.getByRole("button", { name: "Install", exact: true }).click();
    await expect(dialog.getByText("Required", { exact: true })).toBeVisible();

    await dialog.getByLabel("Access token").fill(TOKEN);
    await dialog.getByText("Custom environment variables").click();
    await dialog.getByRole("button", { name: "Add variable" }).click();
    await dialog.getByLabel("Variable name").fill("HTTP_PROXY");
    await dialog.getByLabel("Variable value").fill(PROXY);
    await dialog.getByRole("button", { name: "Install", exact: true }).click();

    await expect(shell.toast("Install started")).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => storedSettings(request), { message: "answers land in OpenBao" })
      .toEqual({ RENOVATE_TOKEN: TOKEN, HTTP_PROXY: PROXY });
    await expect
      .poll(() => installedNames(request), { message: "renovate enters /api/installed", timeout: 15_000 })
      .toContain("renovate");
    expect(repoContains(TOKEN)).toBe(false);
  });

  test("uninstall keeps the OpenBao entry (reinstall stays consistent with kept data)", async ({ request }) => {
    const r = await request.post("/api/apps/renovate/uninstall");
    expect(r.ok()).toBeTruthy();

    await expect
      .poll(() => installedNames(request), { message: "renovate leaves /api/installed", timeout: 15_000 })
      .not.toContain("renovate");
    expect(await storedSettings(request)).toEqual({ RENOVATE_TOKEN: TOKEN, HTTP_PROXY: PROXY });
  });
});
