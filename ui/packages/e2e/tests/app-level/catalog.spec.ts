import { test, expect } from "@playwright/test";
import { CatalogPage } from "../../support/pages/CatalogPage";

test.describe("Catalog page", () => {
  test("renders all user-facing apps and filters out Infrastructure", async ({ page }) => {
    const catalog = new CatalogPage(page);
    await catalog.goto();
    await expect(catalog.card("Vaultwarden")).toBeVisible();
    await expect(catalog.card("Gogs")).toBeVisible();
    await expect(catalog.card("LiteLLM")).toBeVisible();
    await expect(catalog.card("Traefik")).toHaveCount(0);
  });

  test("search filters by displayName/description (case-insensitive)", async ({ page }) => {
    const catalog = new CatalogPage(page);
    await catalog.goto();
    await catalog.search("lite");
    await expect(catalog.card("LiteLLM")).toBeVisible();
    await expect(catalog.card("Vaultwarden")).toHaveCount(0);
  });

  test("search yields a no-matches state and Clear filters resets", async ({ page }) => {
    const catalog = new CatalogPage(page);
    await catalog.goto();
    await catalog.search("zzzznomatch");
    await expect(catalog.noMatchesHeading()).toBeVisible();
    await catalog.clearFilters();
    await expect(catalog.card("Vaultwarden")).toBeVisible();
  });

  test("category chips are single-select and update the URL", async ({ page }) => {
    const catalog = new CatalogPage(page);
    await catalog.goto();
    await catalog.selectCategory("Security");
    await expect(page).toHaveURL(/category=Security/);
    await expect(catalog.card("Vaultwarden")).toBeVisible();
    await expect(catalog.card("LiteLLM")).toHaveCount(0);
    // "All" clears the category
    await catalog.chip("All").click();
    await expect(page).not.toHaveURL(/category=/);
  });

  test("deep-link ?q= and ?category= populate the controls", async ({ page }) => {
    const catalog = new CatalogPage(page);
    await catalog.gotoWith("git", "Development");
    await expect(catalog.searchBox()).toHaveValue("git");
    await expect(catalog.chip("Development")).toHaveAttribute("aria-pressed", "true");
    await expect(catalog.card("Gogs")).toBeVisible();
  });
});
