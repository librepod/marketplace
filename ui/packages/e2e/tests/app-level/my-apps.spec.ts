import { test, expect } from "@playwright/test";
import { AppShell } from "../../support/pages/AppShell";
import { AppDetailPage } from "../../support/pages/AppDetailPage";

test.describe("My Apps page", () => {
  test("empty state when nothing is installed", async ({ page, request }) => {
    // Ensure a clean slate across spec files sharing one Gogs instance.
    for (const name of ["vaultwarden", "litellm"]) {
      const r = await request.get(`/api/apps/${name}`);
      // /api/apps/:name returns a single object with installedStatus.
      if (r.ok() && (await r.json()).installedStatus !== "not_installed") {
        await request.post(`/api/apps/${name}/uninstall`);
      }
    }
    await page.goto("/my-apps");
    await expect(page.getByRole("heading", { name: "No apps installed yet" })).toBeVisible();
  });

  test("installed app appears in the grid", async ({ page }) => {
    const shell = new AppShell(page);
    const detail = new AppDetailPage(page);

    await detail.open("vaultwarden");
    await detail.installButton().click();
    await expect(shell.toast("Install started")).toBeVisible();

    await shell.goToMyApps();
    const card = page.getByRole("link", { name: "Vaultwarden", exact: true });
    await expect(card).toBeVisible();
    // status is 'installing' (no cluster) → badge present, scoped within the card.
    await expect(card.getByRole("status")).toHaveText(/Installing/);
  });
});
