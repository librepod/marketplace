import type { Page, Locator } from "@playwright/test";

export class AppShell {
  constructor(private readonly page: Page) {}

  nav(): Locator {
    return this.page.getByRole("navigation", { name: "Main navigation" });
  }

  goToCatalog(): Promise<void> {
    return this.nav().getByRole("link", { name: "Catalog" }).click();
  }

  goToMyApps(): Promise<void> {
    return this.nav().getByRole("link", { name: "My Apps" }).click();
  }

  // Match toasts by visible text. Sonner success toasts and StatusBadge both
  // carry role="status", so a role query would be ambiguous; text is not.
  toast(text: string): Locator {
    return this.page.getByText(text);
  }
}
