import type { Page, Locator } from "@playwright/test";

export class CatalogPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/");
  }

  async gotoWith(query?: string, category?: string): Promise<void> {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (category) params.set("category", category);
    const qs = params.toString();
    await this.page.goto(qs ? `/?${qs}` : "/");
  }

  card(displayName: string): Locator {
    // AppCard renders a <Link aria-label={displayName}>.
    return this.page.getByRole("link", { name: displayName, exact: true });
  }

  skeletonCount(): Promise<number> {
    return this.page.getByTestId("app-card-skeleton").count();
  }

  searchBox(): Locator {
    return this.page.getByRole("textbox", { name: "Search apps" });
  }

  async search(text: string): Promise<void> {
    await this.searchBox().fill(text);
  }

  clearSearch(): Promise<void> {
    return this.page.getByRole("button", { name: "Clear search" }).click();
  }

  categoryGroup(): Locator {
    return this.page.getByRole("group", { name: "Filter by category" });
  }

  chip(label: string): Locator {
    return this.categoryGroup().getByRole("button", { name: label, exact: true });
  }

  async selectCategory(label: string): Promise<void> {
    await this.chip(label).click();
  }

  noMatchesHeading(): Locator {
    return this.page.getByRole("heading", { name: "No apps found" });
  }

  clearFilters(): Promise<void> {
    return this.page.getByRole("button", { name: "Clear filters" }).click();
  }
}
