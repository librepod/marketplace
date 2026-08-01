import { test, expect } from "@playwright/test";

// Validates the in-cluster deployment: real Gogs, real catalog ConfigMap, live API.
// NB: /api/apps returns a BARE CatalogApp[] (not { apps: [...] }) — see ui/CLAUDE.md.
test("catalog renders against the live cluster", async ({ page, request }) => {
  const apps = (await (await request.get("/api/apps")).json()) as {
    displayName: string;
    category: string;
  }[];
  expect(Array.isArray(apps)).toBeTruthy();
  expect(apps.length).toBeGreaterThan(0);
  // CatalogService filters out Infrastructure apps (system apps, not user-installable).
  expect(apps.every((a) => a.category !== "Infrastructure")).toBeTruthy();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "LibrePod", level: 1 })).toBeVisible();
  // AppCard renders the whole card as a <Link aria-label={displayName}>.
  await expect(page.getByRole("link", { name: apps[0].displayName })).toBeVisible();
});
