import { test, expect } from "@playwright/test";

// `frp-operator` is marked managed via SYSTEM_APPS_OVERRIDE in tier1.config.ts.
const MANAGED = "frp-operator";

test.describe("Platform / system apps", () => {
  test("managed app is excluded from the Catalog API", async ({ request }) => {
    const res = await request.get("/api/apps");
    expect(res.ok()).toBeTruthy();
    const apps = await res.json();
    expect(apps.some((a: { name: string }) => a.name === MANAGED)).toBe(false);
  });

  test("managed app is exposed via /api/system-apps", async ({ request }) => {
    const res = await request.get("/api/system-apps");
    expect(res.ok()).toBeTruthy();
    const apps = await res.json();
    expect(apps.some((a: { name: string }) => a.name === MANAGED)).toBe(true);
  });

  test("installing a managed app is rejected (409)", async ({ request }) => {
    const res = await request.post(`/api/apps/${MANAGED}/install`);
    expect(res.status()).toBe(409);
  });

  test("Platform panel lists the managed app read-only on the home page", async ({ page }) => {
    await page.goto("/");
    // The Platform panel heading
    await expect(page.getByText(/Platform/)).toBeVisible();
    // The managed app row, with its System tag
    await expect(page.getByText("FRP Operator")).toBeVisible();
    await expect(page.getByText("System")).toBeVisible();
    // No install button on the home for it
    await expect(page.getByRole("button", { name: /install/i })).toHaveCount(0);
  });
});
