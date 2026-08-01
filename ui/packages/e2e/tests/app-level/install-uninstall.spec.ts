import { test, expect, type APIRequestContext } from "@playwright/test";
import { AppDetailPage } from "../../support/pages/AppDetailPage";
import { AppShell } from "../../support/pages/AppShell";

// /api/installed returns a bare CatalogApp[] (not { apps: [...] }).
async function installedNames(request: APIRequestContext): Promise<string[]> {
  const res = await request.get("/api/installed");
  const body = (await res.json()) as { name: string }[];
  return body.map((a) => a.name);
}

// Uninstall is exercised API-only here: the Uninstall AlertDialog is only
// reachable at status running/error, which requires a cluster (Tier 2).
// With no cluster, post-install status is stuck at "installing", so the UI
// never offers the Uninstall action — hence the API call instead.
test.describe("install / uninstall against real Gogs", () => {
  test("install commits to Gogs and transitions the UI to installing", async ({
    page,
    request,
  }) => {
    const detail = new AppDetailPage(page);
    const shell = new AppShell(page);
    await detail.open("litellm");

    await detail.installButton().click();
    await expect(shell.toast("Install started")).toBeVisible();

    // The install action becomes a disabled "Installing…" button (status installing).
    await expect(page.getByRole("button", { name: "Installing..." })).toBeDisabled();
    await expect(detail.statusBadge()).toHaveText(/Installing/);

    // App now appears in /api/installed (server derives this from the root
    // kustomization, so membership transitively proves apps/<name> was appended).
    await expect.poll(() => installedNames(request), {
      message: "litellm enters /api/installed",
      timeout: 15_000,
    }).toContain("litellm");
  });

  test("install-when-already-installed is refused (409)", async ({ request }) => {
    const r = await request.post("/api/apps/litellm/install");
    expect(r.status()).toBe(409);
  });

  test("uninstall (API) removes the app and restores the Install action", async ({
    page,
    request,
  }) => {
    const detail = new AppDetailPage(page);

    const r = await request.post("/api/apps/litellm/uninstall");
    expect(r.ok()).toBeTruthy();

    await expect.poll(() => installedNames(request), {
      message: "litellm leaves /api/installed",
      timeout: 15_000,
    }).not.toContain("litellm");

    // Detail reverts to not_installed → Install App button returns.
    await detail.open("litellm");
    await expect(detail.installButton()).toBeVisible();
  });
});
