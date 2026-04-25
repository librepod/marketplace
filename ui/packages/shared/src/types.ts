/**
 * Shared types between server and client.
 * Source of truth for the catalog app schema (mirrors catalog.yaml per-app fields).
 */
export type AppStatus = 'not_installed' | 'installing' | 'running' | 'error';

export interface CatalogApp {
  name: string;
  version: string;
  displayName: string;
  description: string;
  category: string;
  icon: string;
  sourceType: string;
  sourceUrl: string;
  installedStatus?: AppStatus;
}

export interface CatalogFile {
  apiVersion: string;
  kind: string;
  metadata: {
    generatedAt: string;
  };
  apps: CatalogApp[];
}
