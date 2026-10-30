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
export type AppSettingType = 'string' | 'boolean' | 'number' | 'text'; // text = multi-line

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
  /** Shared components picked in the dialog; omitted or empty = none. */
  components?: ComponentRequest[];
}

/** A non-secret component input: asked in the dialog (`install`) or supplied by the app (`app`). */
export interface ComponentValueDef {
  name: string;
  from: 'install' | 'app';
  label?: string;
  description?: string;
  default?: string;
  pattern?: string;
}

/** A shared component as published in catalog.yaml `components:`. */
export interface ComponentDefinition {
  displayName: string;
  description: string;
  version: string;
  group?: string;
  kind: 'patch' | 'resource';
  settings?: AppSettingItem[];
  values?: ComponentValueDef[];
}

/** A component as offered for one app: `values[].default` is final ({app} filled, app values applied). */
export interface AppComponent extends ComponentDefinition {
  name: string;
  values: ComponentValueDef[];
}

export interface ComponentRequest {
  name: string;
  settings?: Record<string, string>;
  values?: Record<string, string>;
}

/**
 * Body of GET /api/apps/:name/settings: the stored answers in the shape install and
 * PUT /api/apps/:name/settings accept. Never includes generated items.
 */
export type AppSettingsValues = Required<InstallRequest>;

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
  secrets?: AppSecretDef[];
  // Install questions + custom-variable opt-in; apps with this open the install dialog.
  settings?: AppSettings;
  // Optional shared components this app lists, joined with their definitions.
  components?: AppComponent[];
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

/** First-run onboarding (the onboarding record in OpenBao system/). `waiting` is
 * never stored: OpenBao is unreachable, or the record is open/claimed and Casdoor
 * is unreachable. */
export type OnboardingState = 'waiting' | 'open' | 'claimed' | 'finished';

/** How the browser reached the server: a raw IPv4/IPv6 literal vs a name. */
export type ArrivalKind = 'ip' | 'domain';

export interface OnboardingStatus {
  state: OnboardingState;
  arrival: ArrivalKind;
  baseDomain: string;
  /** This browser holds a valid onboarding cookie for the current generation. */
  session: boolean;
  // Everything below is null unless `session`.
  /** The personal account confirmed since the last claim ("sign in as …"). */
  account: string | null;
  /** An account kept from before a reset, not yet confirmed since the claim ("keep …"). */
  previousAccount: string | null;
  /** The VPN app's (wg-easy's) install status; null when the read failed. */
  vpnStatus: AppStatus | null;
  peerCount: number | null;
  /** ISO timestamp of the most recent WireGuard handshake, null if none. */
  lastHandshakeAt: string | null;
  /** Pre-fill for the WireGuard endpoint host: the IP the browser used, else DEVICE_IP. */
  endpointSuggestion: string | null;
}

export interface WgPeer {
  clientId: string;
  name: string;
  enabled: boolean;
  latestHandshakeAt: string | null;
}

/** Body of POST /api/bootstrap/install: a VPN app through the catalog's install path.
 * The server answers the app's admin-password question itself; no custom variables. */
export interface BootstrapInstallRequest {
  app: string;
  settings?: Record<string, string>;
}
