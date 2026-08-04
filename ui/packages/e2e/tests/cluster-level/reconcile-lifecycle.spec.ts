import { test, expect, type APIRequestContext } from "@playwright/test";
import { AppDetailPage } from "../../support/pages/AppDetailPage";

type App = { name: string; displayName: string; installedStatus?: string };

// Picks the app to install: LIBREPOD_E2E_APP override, else the first user-facing app.
// /api/apps returns a BARE CatalogApp[] (not { apps: [...] }) — see ui/CLAUDE.md.
async function pickApp(request: APIRequestContext): Promise<string> {
  if (process.env.LIBREPOD_E2E_APP) return process.env.LIBREPOD_E2E_APP;
  const apps = (await (await request.get("/api/apps")).json()) as App[];
  return apps[0].name;
}

// /api/apps/:name returns a SINGLE CatalogApp object (not an array) — so read
// .installedStatus directly, not body.apps[0].installedStatus.
async function getStatus(request: APIRequestContext, name: string): Promise<string | undefined> {
  return (await (await request.get(`/api/apps/${name}`)).json()).installedStatus;
}

// These three tests share one cluster and run in file order (workers:1): the first
// installs and waits for Running; the next two act on that Running app; the last
// uninstalls it. Each later test independently finds a Running app and skips if none.
test.describe("cluster reconcile lifecycle (real Flux)", () => {
  test("install reconciles to Running", async ({ page, request }) => {
    const name = await pickApp(request);
    const detail = new AppDetailPage(page);
    await detail.open(name);
    await expect(detail.installButton()).toBeVisible();
    await detail.installButton().click();

    // Gogs commit → user-apps-source poll → reconcile → CRD Ready → "running". Allow up to 5 min.
    await expect.poll(() => getStatus(request, name), {
      message: `${name} reaches Running`,
      timeout: 300_000,
      intervals: [5_000],
    }).toBe("running");

    await detail.open(name);
    await expect(detail.statusBadge()).toHaveText(/Running/);
  });

  test("at Running: the Open link targets the base domain", async ({ page, request }) => {
    const apps = (await (await request.get("/api/apps")).json()) as App[];
    const running = apps.find((a) => a.installedStatus === "running");
    test.skip(!running, "no app is currently Running");
    const cfg = await (await request.get("/api/config")).json();

    const detail = new AppDetailPage(page);
    await detail.open(running!.name);
    // base-ui <Button render={<a/>}> → role "link", accessible name "Open <displayName>".
    const openLink = page.getByRole("link", { name: new RegExp(`^Open ${running!.displayName}`) });
    await expect(openLink).toHaveAttribute("href", `https://${running!.name}.${cfg.baseDomain}`);
  });

  test("uninstall dialog (reachable at Running) removes the app", async ({ page, request }) => {
    const apps = (await (await request.get("/api/apps")).json()) as App[];
    const running = apps.find((a) => a.installedStatus === "running");
    test.skip(!running, "no app is currently Running");
    const detail = new AppDetailPage(page);
    await detail.open(running!.name);

    // status running → Uninstall action present; opening shows the AlertDialog.
    await detail.uninstallButton().click();
    await expect(page.getByRole("alertdialog")).toBeVisible();

    // "Keep App" (AlertDialogCancel) dismisses and leaves the app installed.
    await detail.keepApp().click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);

    // confirmUninstall opens the dialog (trigger) then clicks the confirm action.
    // Don't pre-open here: the trigger is a toggle, so a second open would close it.
    await detail.confirmUninstall();

    // Root-kustomization entry removed → /api/apps/:name flips to not_installed
    // (independent of Flux pruning the live resources). Allow up to 3 min.
    await expect.poll(() => getStatus(request, running!.name), {
      message: `${running!.name} leaves the installed set`,
      timeout: 180_000,
      intervals: [5_000],
    }).toBe("not_installed");
  });
});
