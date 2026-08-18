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
  // Regression guard for #180 (cold-cluster first-install 500). retries:0 for THIS
  // test only: CI's default retries:2 would silently re-run a first-attempt 500 as
  // "1 flaky" — by retry time the user-apps repo has finished seeding, so it passes
  // green and hides the exact bug (that is how #176/#177 looked "mostly fixed"). The
  // other two lifecycle tests keep the file-default retries; only the first-attempt
  // install assertion must be non-retryable. The genuinely-slow reconcile poll below
  // stays inside this test but is not retry-sensitive — the guard fires at click time.
  test.describe(() => {
    test.describe.configure({ retries: 0 });

    test("install reconciles to Running", async ({ page, request }) => {
      const name = await pickApp(request);
      const detail = new AppDetailPage(page);
      await detail.open(name);
      await expect(detail.installButton()).toBeVisible();

      // Capture the install POST directly so a FIRST-attempt server error (the #180
      // symptom: PUT to a still-commitless flux/user-apps repo → Gogs 500 → the
      // installer 500s) fails the test HERE, before the reconcile poll — instead of
      // being papered over by the UI's error toast + a green retry. The client POSTs
      // /api/apps/:name/install with retry:0, so this response is the first attempt.
      const installResponse = page.waitForResponse(
        (r) => r.url().endsWith(`/api/apps/${name}/install`) && r.request().method() === "POST",
      );
      await detail.installButton().click();
      const res = await installResponse;
      expect(
        res.status(),
        `first-attempt install POST for ${name} must not 5xx on a cold cluster (issue #180); got ${res.status()}`,
      ).toBeLessThan(500);
      expect(res.ok(), `first-attempt install POST for ${name} should succeed (2xx); got ${res.status()}`).toBe(true);

      // Gogs commit → user-apps-source poll → reconcile → CRD Ready → "running". Allow up to 5 min.
      await expect.poll(() => getStatus(request, name), {
        message: `${name} reaches Running`,
        timeout: 300_000,
        intervals: [5_000],
      }).toBe("running");

      await detail.open(name);
      await expect(detail.statusBadge()).toHaveText(/Running/);
    });
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
