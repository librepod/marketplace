import { test, expect } from "@playwright/test";
import { AppShell } from "../../support/pages/AppShell";
import { AppDetailPage } from "../../support/pages/AppDetailPage";

test.describe("My Apps (control plane home)", () => {
  test("first-run welcome when nothing is installed", async ({ page, request }) => {
    // Ensure a clean slate across spec files sharing one Gogs instance.
    for (const name of ["vaultwarden", "litellm"]) {
      const r = await request.get(`/api/apps/${name}`);
      // /api/apps/:name returns a single object with installedStatus.
      if (r.ok() && (await r.json()).installedStatus !== "not_installed") {
        await request.post(`/api/apps/${name}/uninstall`);
      }
    }
    // The installed grid is home; /my-apps is a legacy alias that redirects.
    await page.goto("/my-apps");
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("heading", { name: /welcome to your librepod/i }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /browse the catalog/i })).toBeVisible();
  });

  test("installed app appears as a tile on the home control plane", async ({ page }) => {
    const shell = new AppShell(page);
    const detail = new AppDetailPage(page);

    await detail.open("vaultwarden");
    await detail.installButton().click();
    await expect(shell.toast("Install started")).toBeVisible();

    await shell.goToMyApps();
    await expect(page).toHaveURL(/\/$/);

    // No cluster → status is 'installing', so the tile is not yet a launch link;
    // its body routes to detail and a "Manage" control is always present.
    const manage = page.getByRole("link", { name: "Manage Vaultwarden" });
    await expect(manage).toBeVisible();
    await expect(page.getByText("Vaultwarden")).toBeVisible();
    // The device summary + tile report the installing state.
    await expect(page.getByRole("status").filter({ hasText: /Installing/ }).first()).toBeVisible();
  });
});
