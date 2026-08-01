import type { Page, Locator } from "@playwright/test";

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
  // AlertDialog trigger and its confirm action both read "Uninstall App", so
  // after opening the dialog the action is the second match.
  async confirmUninstall(): Promise<void> {
    await this.uninstallButton().first().click();
    await this.page.getByRole("button", { name: "Uninstall App" }).nth(1).click();
  }

  keepApp(): Locator {
    return this.page.getByRole("button", { name: "Keep App" });
  }
}
