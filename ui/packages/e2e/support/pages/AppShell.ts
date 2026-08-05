import type { Page, Locator } from "@playwright/test";

export class AppShell {
  constructor(private readonly page: Page) {}

  nav(): Locator {
    return this.page.getByRole("navigation", { name: "Main navigation" });
  }

  goToCatalog(): Promise<void> {
    return this.nav().getByRole("link", { name: "Catalog" }).click();
  }

  // The installed-apps control plane is home; its nav item is labelled "Apps".
  goToMyApps(): Promise<void> {
    return this.nav().getByRole("link", { name: "Apps", exact: true }).click();
  }

  // Match toasts by visible text. Sonner success toasts and StatusBadge both
  // carry role="status", so a role query would be ambiguous; text is not.
  toast(text: string): Locator {
    return this.page.getByText(text);
  }
}
