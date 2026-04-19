/**
 * TypeScript interfaces mirroring the catalog.yaml schema.
 * Kept here for server-internal use. Shared interface (CatalogApp) also
 * exported from @librepod/shared for client consumption in Phase 2.
 */
export interface CatalogApp {
  name: string;
  version: string;
  displayName: string;
  description: string;
  category: string;
  icon: string;
  sourceType: string;
  sourceUrl: string;
}

export interface CatalogFile {
  apiVersion: string;
  kind: string;
  metadata: {
    generatedAt: string;
  };
  apps: CatalogApp[];
}
