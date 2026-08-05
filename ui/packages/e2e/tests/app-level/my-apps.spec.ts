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

  test("installed app appears as a tile on the home control plane", async ({ page, request }) => {
    const shell = new AppShell(page);
    const detail = new AppDetailPage(page);

    // Reset to not_installed first: this spec shares one Gogs with the others,
    // and Playwright retries re-enter this test with vaultwarden already
    // installed (no "Install App" button → click times out). Start from a known
    // clean state so install is always available and the run is idempotent.
    const status = await request.get("/api/apps/vaultwarden");
    if (status.ok() && (await status.json()).installedStatus !== "not_installed") {
      await request.post("/api/apps/vaultwarden/uninstall");
    }

    await detail.open("vaultwarden");
    await detail.installButton().click();
    await expect(shell.toast("Install started")).toBeVisible();

    await shell.goToMyApps();
    await expect(page).toHaveURL(/\/$/);

    // No cluster → status is 'installing', so the tile is not yet a launch link;
    // its body routes to detail and a "Manage" control is always present. Assert
    // via the Manage link (unique to the tile) rather than the bare app name —
    // the install-success toast also contains "Vaultwarden", which would make a
    // getByText query a strict-mode violation.
    await expect(page.getByRole("link", { name: "Manage Vaultwarden" })).toBeVisible();
    // The tile's launch/detail link carries the app name + its installing subline.
    await expect(
      page.getByRole("link", { name: /Vaultwarden — Setting up/ }),
    ).toBeVisible();
    // The tile's StatusBadge (a <span role=status>, unlike sonner's <li>) reports
    // the installing state.
    await expect(
      page.locator('span[role="status"]').filter({ hasText: /Installing/ }).first(),
    ).toBeVisible();
  });
});
