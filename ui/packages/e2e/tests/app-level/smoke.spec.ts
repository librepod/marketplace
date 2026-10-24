import { test, expect } from "@playwright/test";

// Validates the whole pipeline: built SPA served by Nest, API reachable, and
// Gogs wired so the catalog loads. /api/apps returns a bare JSON array
// (CatalogApp[]), not { apps: [...] }.
test("app boots and catalog API returns seeded apps", async ({ page, request }) => {
  const res = await request.get("/api/apps");
  expect(res.ok()).toBeTruthy();
  const apps = await res.json();
  const names = (apps as { name: string }[]).map((a) => a.name);
  // System-category apps are filtered out server-side; Infrastructure is a
  // user-facing category (#314).
  expect(names).toEqual(expect.arrayContaining(["vaultwarden", "gogs", "litellm", "kata-containers"]));
  expect(names).not.toContain("traefik");

  // The catalog moved to /catalog; / is now the installed-apps control plane.
  await page.goto("/catalog");
  await expect(page.getByRole("heading", { name: "LibrePod", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Vaultwarden" })).toBeVisible();
});
