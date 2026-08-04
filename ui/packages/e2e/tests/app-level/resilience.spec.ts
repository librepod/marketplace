import { test, expect } from "@playwright/test";

test.describe("resilience", () => {
  test("catalog renders despite flux-unreachable (graceful degradation)", async ({
    page,
    request,
  }) => {
    // Earlier specs share this Gogs and may leave apps installed; reset so
    // vaultwarden is not_installed (otherwise its detail shows "Installing…"
    // instead of "Install App").
    for (const name of ["vaultwarden", "litellm"]) {
      const r = await request.get(`/api/apps/${name}`);
      if (r.ok() && (await r.json()).installedStatus !== "not_installed") {
        await request.post(`/api/apps/${name}/uninstall`);
      }
    }

    // No usable cluster → FluxStatusService degrades silently; the UI still works.
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Vaultwarden" })).toBeVisible();
    // Install actions are actionable even without a cluster.
    await page.getByRole("link", { name: "Vaultwarden" }).click();
    await expect(page.getByRole("button", { name: "Install App" })).toBeVisible();
  });

  test("deep-link reload on a client route does not 404", async ({ page }) => {
    // Navigate client-side, then reload — must serve index.html (SPA fallback).
    await page.goto("/");
    await page.getByRole("link", { name: "My Apps" }).click();
    await expect(page).toHaveURL(/\/my-apps/);
    await page.reload();
    await expect(page.getByRole("heading", { name: /My Apps/ })).toBeVisible();
    expect(page.url()).toMatch(/\/my-apps/);
  });
});
