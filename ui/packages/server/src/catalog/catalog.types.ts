/**
 * TypeScript interfaces mirroring the catalog.yaml schema.
 * Kept here for server-internal use. Shared interface (CatalogApp) also
 * exported from @librepod/shared for client consumption.
 */
import type {
  AppComponent,
  AppStatus,
  AppTemplate,
  AppSecretDef,
  AppSettings,
  ComponentDefinition,
  InstallResult,
} from '@librepod/shared';

export type { AppStatus };
export type { AppTemplate, AppSecretDef, InstallResult };

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
  system?: boolean; // runtime-derived, per-cluster; absent/false = user app
  launchUrl?: string;
  launchable?: boolean;
  templates?: AppTemplate;
  secrets?: AppSecretDef[];
  settings?: AppSettings;
  components?: AppComponent[];
}

/** An app's opt-in as written in metadata.yaml, before the join with the definitions. */
export interface AppComponentRef {
  name: string;
  values?: Record<string, string | number | boolean>;
}

export type RawCatalogApp = Omit<CatalogApp, 'components'> & { components?: AppComponentRef[] };

export interface CatalogFile {
  apiVersion: string;
  kind: string;
  metadata: {
    generatedAt: string;
  };
  apps: RawCatalogApp[];
  components?: Record<string, ComponentDefinition>;
}
