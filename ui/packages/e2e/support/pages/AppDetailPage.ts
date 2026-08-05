import { expect, type Page, type Locator } from "@playwright/test";

export class AppDetailPage {
  constructor(private readonly page: Page) {}

  async open(name: string): Promise<void> {
    await this.page.goto(`/apps/${name}`);
  }

  async backToCatalog(): Promise<void> {
    // The link text includes a unicode arrow; match on the stable substring.
    await this.page.getByRole("link", { name: /Back to catalog/ }).click();
  }

  // AppShell's "LibrePod" h1 lives in <header>; the detail title is the only
  // h1 inside <main>, so scope there to avoid a two-heading ambiguity.
  title(): Locator {
    return this.page.locator("main").getByRole("heading", { level: 1 });
  }

  // StatusBadge is a <span role="status">; sonner toasts are <li role="status">.
  // Restricting to <span> targets the badge and excludes toasts.
  statusBadge(): Locator {
    return this.page.locator('span[role="status"]');
  }

  // The link's accessible name has a sr-only " (opens in a new tab)" suffix.
  viewProjectLink(): Locator {
    return this.page.getByRole("link", { name: /View project/ });
  }

  installButton(): Locator {
    return this.page.getByRole("button", { name: "Install App" });
  }

  uninstallButton(): Locator {
    return this.page.getByRole("button", { name: "Uninstall App" });
  }

  // Only reachable at status running/error (needs a cluster → Tier 2). The
  // AlertDialog trigger and its confirm action both read "Uninstall App"; scope
  // the confirm click to the open dialog so it can never match the trigger
  // (which lives outside the alertdialog), and assert the dialog opened first.
  // The trigger is a toggle: if base-ui's open state hasn't settled after a
  // prior Keep-App dismissal, .first().click() can CLOSE instead of OPEN —
  // asserting visibility surfaces that as a clear failure rather than a cryptic
  // 15s timeout on a positional .nth(1) that never resolves.
  async confirmUninstall(): Promise<void> {
    await this.uninstallButton().first().click();
    const dialog = this.page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Uninstall App" }).click();
  }

  keepApp(): Locator {
    return this.page.getByRole("button", { name: "Keep App" });
  }
}
