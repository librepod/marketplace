/**
 * Shared types between server and client.
 * Source of truth for the catalog app schema (mirrors catalog.yaml per-app fields).
 */
export type AppStatus = 'not_installed' | 'installing' | 'running' | 'error';

export interface AppTemplate {
  source: string;
  release: string;
  secret?: string;
  kustomization: string;
}

export interface AppParam {
  name: string;
  description: string;
  type: string;
  example?: string;
}

export interface AppSecretDef {
  name: string;
  description?: string;
  required: boolean;
  generate?: {
    type: string;
    length: number;
  };
}

export interface InstallResult {
  success: boolean;
  message: string;
}

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
  templates?: AppTemplate;
  params?: { required?: AppParam[] };
  secrets?: AppSecretDef[];
}

export interface CatalogFile {
  apiVersion: string;
  kind: string;
  metadata: {
    generatedAt: string;
  };
  apps: CatalogApp[];
}

/**
 * Public device configuration the SPA needs to build user-facing links.
 * `baseDomain` mirrors the installer's BASE_DOMAIN env var (see InstalledService),
 * so per-app `https://<name>.<baseDomain>` links match the deployed IngressRoute host.
 */
export interface MarketplaceConfig {
  baseDomain: string;
}

/**
 * Authenticated user identity. Populated by GET /api/me from the Casdoor
 * session. Server-side this is the public subset of SessionClaims (no iat/exp).
 */
export interface User {
  sub: string;
  name: string;
  email: string;
}
