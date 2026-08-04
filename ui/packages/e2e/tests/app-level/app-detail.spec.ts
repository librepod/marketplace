import { test, expect } from "@playwright/test";
import { CatalogPage } from "../../support/pages/CatalogPage";
import { AppDetailPage } from "../../support/pages/AppDetailPage";

test.describe("App detail page", () => {
  test("navigates from a card and renders metadata + install action", async ({ page }) => {
    const catalog = new CatalogPage(page);
    const detail = new AppDetailPage(page);
    await catalog.goto();
    await catalog.card("Vaultwarden").click();
    await expect(page).toHaveURL(/\/apps\/vaultwarden/);
    await expect(detail.title()).toHaveText("Vaultwarden");
    await expect(page.getByText("1.35.2", { exact: true })).toBeVisible();
    await expect(detail.installButton()).toBeVisible();
    await expect(detail.uninstallButton()).toHaveCount(0); // not_installed → no uninstall
  });

  test("shows View project link only for http(s) sourceUrl", async ({ page }) => {
    const detail = new AppDetailPage(page);

    await detail.open("vaultwarden"); // sourceUrl: https://...
    await expect(detail.viewProjectLink()).toBeVisible();
    await expect(detail.viewProjectLink()).toHaveAttribute(
      "href",
      "https://github.com/dani-garcia/vaultwarden",
    );

    await detail.open("litellm"); // sourceUrl: oci://... → link hidden
    await expect(detail.viewProjectLink()).toHaveCount(0);
  });

  test("unknown app shows the not-found state", async ({ page }) => {
    await page.goto("/apps/does-not-exist");
    await expect(page.getByRole("heading", { name: "App not found" })).toBeVisible();
    await expect(page.getByText("This app doesn't exist in the catalog.")).toBeVisible();
  });
});
