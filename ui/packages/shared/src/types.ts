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

/** Type of an install question's answer. Answers always travel and are stored as text. */
export type AppSettingType = 'string' | 'boolean' | 'number';

/**
 * One install-time question (metadata.yaml spec.settings.items[]). Only questions an app
 * deliberately asks — LibrePod's tuned defaults stay in the app's .env and are never listed.
 */
export interface AppSettingItem {
  name: string;
  label?: string;
  description?: string;
  type?: AppSettingType;
  /** Fixed choices → dropdown. YAML may give numbers/booleans; compare with String(). */
  options?: Array<string | number | boolean>;
  /**
   * Pre-fills the answer. YAML may give a boolean/number; normalise with String().
   * A bare `default:` parses as null and means "no default".
   */
  default?: string | number | boolean | null;
  required?: boolean;
  /** UI masking only — every value is stored the same way. */
  sensitive?: boolean;
  /**
   * Machine-generated secret (DB password, session key): never shown in the dialog.
   * Resolution: the answer → the value already stored in the OpenBao entry (a reinstall
   * keeps the running secret) → `default` → fresh random of this length. Keep legacy
   * lengths verbatim.
   */
  generate?: { length: number };
}

export interface AppSettings {
  /** Offer the free-form "Custom environment variables" section (default false). */
  allowCustom?: boolean;
  items?: AppSettingItem[];
}

export interface CustomVariable {
  name: string;
  value: string;
}

/**
 * Body of POST /api/apps/:name/install. Omitted or empty = all defaults. A question left
 * out of `settings` gets its default; an empty answer leaves it unset.
 */
export interface InstallRequest {
  settings?: Record<string, string>;
  custom?: CustomVariable[];
}

/** One field-level problem: `name` is a question name, `custom.<i>`, `settings` or `custom`. */
export interface FieldError {
  name: string;
  message: string;
}

/** 400 body of POST /api/apps/:name/install when settings fail validation. */
export interface InstallValidationErrorBody {
  message: string;
  errors: FieldError[];
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
  // Axis A: runtime-enriched launch-URL override; present only when one of the
  // app's IngressRoutes carries the `librepod.org/launch` annotation.
  launchUrl?: string;
  // Axis B: runtime-enriched. `false` only when the app has NO IngressRoute (no
  // web UI). Absent (undefined) means "unknown" and is treated as launchable.
  launchable?: boolean;
  templates?: AppTemplate;
  params?: { required?: AppParam[] };
  secrets?: AppSecretDef[];
  // Install questions + custom-variable opt-in; apps with this open the install dialog.
  settings?: AppSettings;
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
