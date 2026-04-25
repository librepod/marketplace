# Phase 3: Installed Apps + Live Status - Research

**Researched:** 2026-04-21
**Domain:** NestJS service integration — Gogs HTTP API + @kubernetes/client-node (FluxCD CRDs) + React UI additions
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Gogs Integration**
- D-01: Read installed apps via Gogs HTTP API — call the Gogs REST API to parse the root `kustomization.yaml` in the `flux/user-apps` repo.
- D-02: Gogs credentials injected via env vars: `GOGS_URL` and `GOGS_TOKEN`. Same pattern as `CATALOG_PATH` from Phase 1.
- D-03: User-apps repo uses a single root `kustomization.yaml` with a `resources:` list. An app is installed if its path appears there.

**Kubernetes / FluxCD Integration**
- D-04: Use `@kubernetes/client-node` (official Kubernetes JS client) to query FluxCD CRDs.
- D-05: Query Kustomization and HelmRelease FluxCD CRDs for per-app reconciliation status.
- D-06: Marketplace-ui pod gets a dedicated ServiceAccount with a ClusterRole granting `get`, `list`, `watch` on `kustomizations.kustomize.toolkit.fluxcd.io` and `helmreleases.helm.toolkit.fluxcd.io` across all namespaces. No other resource access.

**Status Model**
- D-07: Gogs-first, then FluxCD: not in kustomization.yaml → `not_installed`; in kustomization.yaml: FluxCD `Ready: True` → `running`, `Reconciling: True` → `installing`, `Failed: True` → `error`, CRD not found yet → `installing`
- D-08: Status type: `'not_installed' | 'installing' | 'running' | 'error'`
- D-09: Enrich existing `GET /api/apps` response — add `installedStatus` field to each `CatalogApp`.
- D-10: Add `GET /api/installed` endpoint returning only apps where `installedStatus !== 'not_installed'`.

**My Apps Page (Frontend)**
- D-11: My Apps is a separate route at `/my-apps` with a nav bar added to `AppShell`. Nav links: "Catalog" (→ `/`) and "My Apps" (→ `/my-apps`).
- D-12: My Apps page uses the same AppCard grid layout as CatalogPage, reusing the `AppCard` component.
- D-13: Status badge is a small colored dot or pill in the top-right corner of each AppCard. Colors: green = running, blue/yellow = installing, red = error.

### Claude's Discretion
- Exact nav bar markup and styling in AppShell (consistent with existing shadcn/Tailwind patterns)
- Status badge exact shape, size, and label text (dot vs pill, whether text "Running" shows or dot-only)
- Empty state for My Apps page when no apps are installed
- Error handling when Gogs API is unreachable (graceful degradation — return `not_installed` for all)
- Error handling when k8s API is unreachable (graceful degradation — return `installing` for Gogs-present apps)
- `InstalledApp` type shape in `@librepod/shared`

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BACK-02 | Backend reads installed app state from Gogs user-apps repo | Gogs HTTP API raw endpoint; parse root kustomization.yaml resources list |
| BACK-03 | Backend queries FluxCD Kustomization/HelmRelease CRDs for app reconciliation status (Ready/Progressing/Failed) | @kubernetes/client-node CustomObjectsApi; label selector `marketplace.io/app={name}` |
| INST-03 | User can view "My Apps" page showing all currently installed apps | New `/my-apps` route; `GET /api/installed`; reuse AppCard |
| STAT-01 | Each app shows a status indicator (not installed / installing / running / error) | Status badge overlay on AppCard; `installedStatus` field in `CatalogApp` |
</phase_requirements>

---

## Summary

Phase 3 adds two backend capabilities (Gogs read + FluxCD status) and two frontend additions (status badges + My Apps page) to the existing NestJS/React stack. All decisions are locked; research focuses on exact API shapes, CRD condition mapping, and safe integration patterns.

The backend gains a new `InstalledModule` with two collaborating services: `GogsService` (reads the user-apps repo root `kustomization.yaml` via Gogs HTTP API) and `FluxStatusService` (queries FluxCD Kustomization and HelmRelease CRDs via `@kubernetes/client-node`). The existing `CatalogService.findAll()` is enriched by calling both services before returning the response. The frontend gains a status badge overlay on `AppCard`, a nav bar in `AppShell`, a new `/my-apps` route, and a `MyAppsPage` component.

The critical implementation insight discovered during research: **every installed app's FluxCD resources are labeled with `marketplace.io/app: {appname}`** in the templates baked into each app's `metadata.yaml`. This label is reliable across all 20 apps in the catalog and enables a deterministic lookup strategy — query for Kustomization or HelmRelease with label selector `marketplace.io/app={name}` in `flux-system` namespace, rather than guessing resource names.

**Primary recommendation:** Add `InstalledModule` to `app.module.ts` using the identical NestJS DI pattern as `CatalogModule`. `GogsService` fetches the raw `kustomization.yaml` from the Gogs API with a Bearer token. `FluxStatusService` uses `@kubernetes/client-node` CustomObjectsApi with `loadFromCluster()` + label selector lookup. Enrichment happens in a new `InstalledController` that composes `CatalogService` + `GogsService` + `FluxStatusService`.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Installed app detection (Gogs read) | API / Backend | — | Backend is sole integration point with Gogs; dumb frontend pattern |
| FluxCD CRD status query | API / Backend | — | k8s API access is backend-only; no k8s credentials in frontend |
| Status enrichment of GET /api/apps | API / Backend | — | Backend enriches before returning; frontend receives pre-computed field |
| GET /api/installed endpoint | API / Backend | — | New endpoint, same tier as existing /api/apps |
| Status badge rendering | Browser / Client | — | Pure UI concern; receives `installedStatus` string, renders color/shape |
| My Apps page | Browser / Client | — | New route; fetches /api/installed; renders AppCard grid |
| Nav bar (Catalog / My Apps) | Browser / Client | — | AppShell layout concern |
| ServiceAccount + RBAC | Kubernetes manifests | — | Phase 3 defines RBAC design; Phase 5 applies it as K8s manifests |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@kubernetes/client-node` | 1.4.0 | Query FluxCD CRDs from inside cluster | Official Kubernetes JS client; auto reads in-cluster ServiceAccount token via `loadFromCluster()` |
| `js-yaml` | 4.1.1 | Parse Gogs raw kustomization.yaml content | Already in server deps; same library used for catalog.yaml parsing |
| Node.js built-in `fetch` / `undici` | Node 22 built-in | HTTP calls to Gogs API | Node 22 includes native fetch; no extra dependency needed |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@nestjs/config` + `ConfigService` | 4.0.4 (already installed) | Read `GOGS_URL` and `GOGS_TOKEN` env vars | Identical pattern to `CATALOG_PATH` in CatalogService |
| `react-router-dom` NavLink | already installed | Active nav link styling | Use NavLink (not Link) for "Catalog" / "My Apps" — applies active class automatically |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Native fetch for Gogs API | `axios` or `node-fetch` | Native fetch is sufficient; no extra dependency |
| Label selector lookup | Name-based lookup (`marketplace-{appname}`) | Label selector is more robust; name pattern matches all current apps but label is explicit contract |
| `loadFromCluster()` | `loadFromDefault()` | `loadFromCluster()` is more explicit for in-pod use; `loadFromDefault()` also works (falls back to cluster if no kubeconfig) |

**Installation:**
```bash
cd /home/alex/code/librepod/marketplace/ui/packages/server
npm install @kubernetes/client-node
```

**Version verification:**
```bash
npm view @kubernetes/client-node version
# Returns: 1.4.0  [VERIFIED: npm registry 2026-04-21]
```

---

## Architecture Patterns

### System Architecture Diagram

```
Browser
  |
  |-- GET / (catalog)     → AppShell + CatalogPage
  |                           AppCard grid (each card has installedStatus badge)
  |-- GET /my-apps        → AppShell + MyAppsPage
  |                           AppCard grid (only installed apps)
  |-- GET /apps/:name     → AppShell + AppDetailPage
                              shows installedStatus in detail view (Phase 3 adds field)
        |
        | fetch("/api/apps")                    fetch("/api/installed")
        |                                              |
NestJS API
  |
  CatalogController.findAll()      InstalledController.findInstalled()
        |                                  |
  CatalogService.findAll()         - CatalogService.findAll() [reused]
        |                          - GogsService.getInstalledAppNames()
  + InstalledService.enrich()      - FluxStatusService.getStatusFor(name)
        |                                  |
        |-- GogsService                    |
        |     GET /api/v1/repos/flux/user-apps/raw/master/kustomization.yaml
        |     (Authorization: token GOGS_TOKEN)
        |     Gogs at http://gogs.gogs.svc.cluster.local:80
        |
        |-- FluxStatusService
              CustomObjectsApi.listNamespacedCustomObject({
                group: "kustomize.toolkit.fluxcd.io",
                version: "v1",
                namespace: "flux-system",
                plural: "kustomizations",
                labelSelector: "marketplace.io/app=<appname>"
              })
              + same for helmreleases (helm.toolkit.fluxcd.io/v2)
              → parse .status.conditions[] for Ready/Reconciling/Stalled
```

### Recommended Project Structure

```
ui/packages/server/src/
├── app.module.ts              # Add InstalledModule import here
├── catalog/                   # Existing (Phase 1) — add enrich() method
│   ├── catalog.controller.ts  # Calls InstalledService to enrich response
│   ├── catalog.service.ts     # findAll() / findOne() — unchanged logic
│   └── catalog.types.ts       # Add installedStatus field to CatalogApp
├── installed/                 # NEW module
│   ├── installed.module.ts
│   ├── installed.controller.ts  # GET /api/installed
│   ├── installed.service.ts     # Compose Gogs + FluxStatus
│   ├── gogs.service.ts          # Gogs HTTP API client
│   ├── flux-status.service.ts   # @kubernetes/client-node CRD queries
│   └── installed.types.ts       # InstalledApp, AppStatus types
└── shared/                    # @librepod/shared types (update CatalogApp)

ui/packages/client/src/
├── components/
│   ├── AppCard.tsx            # Add status badge overlay (top-right)
│   ├── AppShell.tsx           # Add nav bar (Catalog + My Apps links)
│   └── StatusBadge.tsx        # NEW — colored dot/pill component
├── pages/
│   ├── CatalogPage.tsx        # Unchanged — receives installedStatus in data
│   ├── MyAppsPage.tsx         # NEW — fetches /api/installed, same AppCard grid
│   └── AppDetailPage.tsx      # Show installedStatus badge (minor addition)
└── router.tsx                 # Add /my-apps route

ui/packages/shared/src/
└── types.ts                   # Add installedStatus to CatalogApp interface
```

### Pattern 1: GogsService — Raw File Fetch

**What:** Fetch the raw `kustomization.yaml` from the Gogs API and parse the `resources:` list.
**When to use:** On every call to GET /api/apps or GET /api/installed.

```typescript
// Source: Gogs docs-api (https://github.com/gogs/docs-api/blob/master/Repositories/Contents.md)
// [VERIFIED: official Gogs API documentation]

@Injectable()
export class GogsService {
  constructor(private readonly config: ConfigService) {}

  private get gogsUrl(): string {
    return this.config.get<string>('GOGS_URL', 'http://gogs.gogs.svc.cluster.local:80');
  }

  private get gogsToken(): string {
    return this.config.get<string>('GOGS_TOKEN', '');
  }

  async getInstalledAppNames(): Promise<string[]> {
    // GET /api/v1/repos/{owner}/{repo}/raw/{ref}/{path}
    // Returns raw file content with Content-Type: text/plain
    const url = `${this.gogsUrl}/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `token ${this.gogsToken}` },
      });
      if (!res.ok) {
        // Graceful degradation: Gogs unreachable → treat all as not_installed
        return [];
      }
      const content = await res.text();
      const parsed = yaml.load(content) as { resources?: string[] };
      // Each entry is like "vaultwarden/" or "vaultwarden" — strip trailing slash
      return (parsed?.resources ?? []).map((r) => r.replace(/\/$/, ''));
    } catch {
      return [];
    }
  }
}
```

### Pattern 2: FluxStatusService — CRD Query by Label

**What:** Query FluxCD Kustomization and HelmRelease CRDs using label `marketplace.io/app={name}` in `flux-system` namespace.
**When to use:** Per-app status lookup after Gogs confirms app is installed.

```typescript
// Source: Context7 /kubernetes-client/javascript — CustomObjectsApi
// [VERIFIED: Context7 official docs 2026-04-21]

@Injectable()
export class FluxStatusService implements OnModuleInit {
  private customObjectsApi: CustomObjectsApi;

  onModuleInit() {
    const kc = new KubeConfig();
    kc.loadFromCluster();         // reads /var/run/secrets/kubernetes.io/serviceaccount/
    this.customObjectsApi = kc.makeApiClient(CustomObjectsApi);
  }

  async getStatusFor(appName: string): Promise<AppStatus> {
    const labelSelector = `marketplace.io/app=${appName}`;
    try {
      // Try Kustomization first (oci-kustomize apps)
      const kustResp = await this.customObjectsApi.listNamespacedCustomObject({
        group: 'kustomize.toolkit.fluxcd.io',
        version: 'v1',
        namespace: 'flux-system',
        plural: 'kustomizations',
        labelSelector,
      });
      const kustItems = (kustResp as any).items ?? [];
      if (kustItems.length > 0) {
        return this.deriveStatusFromConditions(kustItems[0].status?.conditions ?? []);
      }

      // Fallback: try HelmRelease (helm-based apps like open-webui)
      const helmResp = await this.customObjectsApi.listNamespacedCustomObject({
        group: 'helm.toolkit.fluxcd.io',
        version: 'v2',
        namespace: 'flux-system',
        plural: 'helmreleases',
        labelSelector,
      });
      const helmItems = (helmResp as any).items ?? [];
      if (helmItems.length > 0) {
        return this.deriveStatusFromConditions(helmItems[0].status?.conditions ?? []);
      }

      // CRD not found yet (propagation lag after Gogs commit) → installing
      return 'installing';
    } catch {
      // k8s API unreachable → graceful degradation
      return 'installing';
    }
  }

  private deriveStatusFromConditions(conditions: any[]): AppStatus {
    const ready = conditions.find((c: any) => c.type === 'Ready');
    const reconciling = conditions.find((c: any) => c.type === 'Reconciling');

    if (ready?.status === 'True') return 'running';
    if (reconciling?.status === 'True') return 'installing';
    if (ready?.status === 'False') return 'error';
    return 'installing'; // Unknown / no conditions yet
  }
}
```

### Pattern 3: Enrich CatalogService Response

**What:** `InstalledService.enrich()` wraps both Gogs and FluxCD lookups, returning `CatalogApp[]` with `installedStatus` field populated.
**When to use:** Called from `CatalogController.findAll()` and `InstalledController.findInstalled()`.

```typescript
// Source: project pattern — mirrors CatalogService.findAll() composition
// [ASSUMED] — derived from existing project patterns

@Injectable()
export class InstalledService {
  constructor(
    private readonly gogs: GogsService,
    private readonly flux: FluxStatusService,
    private readonly catalog: CatalogService,
  ) {}

  async enrich(apps: CatalogApp[]): Promise<CatalogApp[]> {
    const installedNames = await this.gogs.getInstalledAppNames();
    const installedSet = new Set(installedNames);

    return Promise.all(
      apps.map(async (app) => {
        if (!installedSet.has(app.name)) {
          return { ...app, installedStatus: 'not_installed' as AppStatus };
        }
        const status = await this.flux.getStatusFor(app.name);
        return { ...app, installedStatus: status };
      }),
    );
  }

  async getInstalled(): Promise<CatalogApp[]> {
    const all = await this.enrich(this.catalog.findAll());
    return all.filter((app) => app.installedStatus !== 'not_installed');
  }
}
```

### Pattern 4: StatusBadge Component

**What:** Small colored dot or pill in the top-right corner of AppCard. Only renders when `installedStatus !== 'not_installed'`.
**When to use:** Inside `AppCard` as an absolute-positioned overlay.

```typescript
// Source: shadcn Badge component (already in ui/packages/client/src/components/ui/badge.tsx)
// [VERIFIED: existing codebase — badge.tsx is present]

const STATUS_CONFIG = {
  running:    { label: 'Running',    dot: 'bg-green-500' },
  installing: { label: 'Installing', dot: 'bg-yellow-400' },
  error:      { label: 'Error',      dot: 'bg-red-500' },
} as const;

export function StatusBadge({ status }: { status: Exclude<AppStatus, 'not_installed'> }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className="flex items-center gap-1 text-xs font-medium">
      <span className={cn('h-2 w-2 rounded-full', cfg.dot)} />
      {cfg.label}
    </span>
  );
}

// In AppCard.tsx — add relative to CardContent, position badge top-right:
// <div className="relative">
//   {app.installedStatus && app.installedStatus !== 'not_installed' && (
//     <div className="absolute top-0 right-0 -mt-1 -mr-1">
//       <StatusBadge status={app.installedStatus} />
//     </div>
//   )}
//   ...existing card content...
// </div>
```

### Pattern 5: AppShell Nav Bar

**What:** Add nav links "Catalog" and "My Apps" to AppShell. Use React Router `NavLink` for active state styling.
**When to use:** Replace the static header in AppShell.

```typescript
// Source: react-router-dom NavLink pattern
// [VERIFIED: react-router-dom already installed in client package]

import { NavLink, Outlet } from "react-router-dom"

// NavLink applies aria-current="page" and className({ isActive }) pattern
// Use isActive to toggle active style (e.g., font-semibold text-foreground vs text-muted-foreground)
```

### Anti-Patterns to Avoid

- **Sequential status fetches per app:** Do NOT `await flux.getStatusFor(app1)` then `await flux.getStatusFor(app2)` in a loop. Use `Promise.all()` to fan out concurrently — the k8s API handles concurrent reads fine.
- **Storing FluxCD CRD results in module-level cache:** Status must be fresh on each API call. No caching of FluxCD conditions.
- **Letting k8s errors surface as 500s:** Wrap all `CustomObjectsApi` calls in try/catch. Return `'installing'` on any k8s error (graceful degradation).
- **Importing `@kubernetes/client-node` in `onModuleInit` synchronously when running tests:** Use conditional in-cluster config, or mock `FluxStatusService` entirely in unit tests.
- **Querying CRDs by name pattern (`marketplace-{appname}`):** Use the label selector approach instead — more robust and explicit contract.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| K8s API authentication in-cluster | Custom token file reader | `kc.loadFromCluster()` from `@kubernetes/client-node` | Handles token rotation, CA cert, namespace automatically |
| HTTP client for Gogs | Custom fetch wrapper with retry | Native `fetch` + try/catch | Node 22 has native fetch; retry would require exponential backoff logic |
| YAML parsing of kustomization.yaml | Regex / string split on `resources:` | `js-yaml` (already installed) | YAML multiline strings, anchors, quotes all handled |
| Active nav link state | Manual `useLocation()` comparison | React Router `NavLink` | Handles aria-current, active class, hash routing edge cases |
| Status badge color logic | Inline ternary chains | `STATUS_CONFIG` lookup table | Maintainable; easy to extend when more states added |

**Key insight:** The k8s API TLS bootstrapping and token refresh logic alone is enough reason to never hand-roll — `@kubernetes/client-node` handles all of it.

---

## Runtime State Inventory

> Not applicable. This is a greenfield feature addition, not a rename/refactor/migration phase.

---

## Common Pitfalls

### Pitfall 1: Gogs API Endpoint Shape
**What goes wrong:** Using the GitHub-compatible `/contents/:path` endpoint instead of the raw endpoint. The `/contents/:path` response returns base64-encoded content in a JSON envelope. The raw endpoint returns the file text directly.
**Why it happens:** Both endpoints exist in Gogs; GitHub-style is documented more prominently.
**How to avoid:** Use `GET /api/v1/repos/flux/user-apps/raw/master/kustomization.yaml` — the `raw` segment returns the kustomization.yaml as plain text, ready for `yaml.load()`.
**Warning signs:** Parsing returns `undefined` or a base64 string instead of a YAML object.

### Pitfall 2: FluxCD Condition Field Access via `any` Cast
**What goes wrong:** `@kubernetes/client-node` v1.x returns CRD responses typed as `object` (not the specific CRD schema). Accessing `.status.conditions` without casting causes TypeScript errors.
**Why it happens:** The client cannot know the CRD schema at compile time.
**How to avoid:** Cast the response items to `any` or define a local `FluxCondition` interface. The `status.conditions` array has `{ type, status, reason, message }` fields.
**Warning signs:** TypeScript error `Property 'items' does not exist on type 'object'`.

### Pitfall 3: `Promise.all()` Status Fetch — K8s Rate Limiting
**What goes wrong:** Fetching status for all 12 user-facing apps concurrently fires 12-24 k8s API calls simultaneously (Kustomization + HelmRelease per app).
**Why it happens:** `Promise.all()` does not throttle.
**How to avoid:** Because Phase 3 has no install/uninstall yet, the number of installed apps is typically 0. The fan-out is bounded by installed apps. For Phase 3, `Promise.all()` is safe. Add throttling in Phase 4 if needed.
**Warning signs:** k8s API returns 429 (too many requests) in logs.

### Pitfall 4: Gogs Repo Owner/Repo Name
**What goes wrong:** The user-apps Gogs repo is at `flux/user-apps`, not `admin/user-apps`. The Gogs owner name is `flux` (the user that Gogs bootstraps with for FluxCD integration).
**Why it happens:** Guessing the owner name from context.
**How to avoid:** Confirmed from `infrastructure/user-apps-source/gitrepository.yaml`: URL is `http://gogs.gogs.svc.cluster.local:80/flux/user-apps.git`. Owner = `flux`, repo = `user-apps`.
**Warning signs:** Gogs API returns 404 on the raw file fetch.

### Pitfall 5: `loadFromCluster()` Fails in Local Dev
**What goes wrong:** `kc.loadFromCluster()` throws when running the NestJS server locally (outside a pod) because there is no `/var/run/secrets/kubernetes.io/serviceaccount/token`.
**Why it happens:** `loadFromCluster()` is in-pod only.
**How to avoid:** In `FluxStatusService.onModuleInit()`, wrap in try/catch and fall back to `loadFromDefault()` (reads `~/.kube/config`). Or use an env var `KUBERNETES_SERVICE_HOST` check — this env var is only set inside pods. When absent, fall back to `loadFromDefault()`.
**Warning signs:** `Error: Service host/port is not set!` during local `nest start --watch`.

```typescript
onModuleInit() {
  const kc = new KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();  // use kubeconfig for local dev
  }
  this.customObjectsApi = kc.makeApiClient(CustomObjectsApi);
}
```

### Pitfall 6: `installedStatus` Field on `CatalogApp` — Type Update Cascade
**What goes wrong:** Adding `installedStatus` to `CatalogApp` in `@librepod/shared/src/types.ts` but forgetting to update the internal `catalog.types.ts` in the server package, or vice versa.
**Why it happens:** The field appears in two places — shared types and server-internal types.
**How to avoid:** Update `@librepod/shared/src/types.ts` first (source of truth). Server's `catalog/catalog.types.ts` should either import from shared or be updated to match. The `installedStatus` field is optional (`installedStatus?: AppStatus`) — the catalog API can omit it without breaking.
**Warning signs:** TypeScript error in `catalog.controller.ts` when returning enriched apps.

### Pitfall 7: kustomization.yaml Resources Entry Format
**What goes wrong:** Assuming resources entries are always bare app names (`vaultwarden`). Actual entries may be directory references (`vaultwarden/`).
**Why it happens:** Kustomize convention for referencing a directory adds a trailing slash.
**How to avoid:** Strip trailing slashes when parsing: `(entry.replace(/\/$/, ''))`. The CONTEXT.md confirms this: "e.g. `- vaultwarden/`, `- gogs/`".
**Warning signs:** `installedSet.has('vaultwarden')` returns false when the entry in Gogs is `vaultwarden/`.

---

## Code Examples

### Full GogsService Implementation Pattern

```typescript
// Source: Gogs API docs-api + project ConfigService pattern
// [VERIFIED: Gogs raw endpoint, VERIFIED: ConfigService pattern from catalog.service.ts]

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as yaml from 'js-yaml';

@Injectable()
export class GogsService {
  constructor(private readonly config: ConfigService) {}

  async getInstalledAppNames(): Promise<string[]> {
    const gogsUrl = this.config.get<string>(
      'GOGS_URL',
      'http://gogs.gogs.svc.cluster.local:80',
    );
    const token = this.config.get<string>('GOGS_TOKEN', '');

    const url = `${gogsUrl}/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `token ${token}` },
      });
      if (!res.ok) return [];
      const text = await res.text();
      const parsed = yaml.load(text) as { resources?: string[] } | null;
      return (parsed?.resources ?? []).map((r: string) => r.replace(/\/$/, ''));
    } catch {
      return [];
    }
  }
}
```

### FluxCD Status Condition Derivation

```typescript
// Source: FluxCD official docs (https://fluxcd.io/flux/components/kustomize/kustomizations/)
// [CITED: fluxcd.io/flux/components/kustomize/kustomizations/]

// Condition types present in FluxCD Kustomization and HelmRelease:
// - type: "Ready"        status: "True" | "False" | "Unknown"
// - type: "Reconciling"  status: "True" | "False"
// - type: "Stalled"      status: "True" | "False"

// Status derivation algorithm (from D-07):
// 1. Ready.status === "True"  → 'running'
// 2. Reconciling.status === "True" → 'installing'
// 3. Ready.status === "False" → 'error'
// 4. No conditions / Unknown → 'installing' (propagation lag)

interface FluxCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
}

function deriveStatus(conditions: FluxCondition[]): AppStatus {
  const ready = conditions.find((c) => c.type === 'Ready');
  const reconciling = conditions.find((c) => c.type === 'Reconciling');
  if (ready?.status === 'True') return 'running';
  if (reconciling?.status === 'True') return 'installing';
  if (ready?.status === 'False') return 'error';
  return 'installing';
}
```

### NestJS Module Registration

```typescript
// Source: existing app.module.ts + catalog.module.ts patterns
// [VERIFIED: codebase inspection 2026-04-21]

// installed.module.ts
@Module({
  imports: [CatalogModule],  // needs CatalogService
  controllers: [InstalledController],
  providers: [InstalledService, GogsService, FluxStatusService],
  exports: [InstalledService],  // exported so CatalogModule can import
})
export class InstalledModule {}

// app.module.ts
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CatalogModule,
    InstalledModule,  // ADD THIS
    HealthModule,
  ],
})
export class AppModule {}

// catalog.module.ts — needs InstalledService for enrichment
@Module({
  imports: [InstalledModule],  // ADD THIS
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}
```

**Circular dependency risk:** If `CatalogModule` imports `InstalledModule` and `InstalledModule` imports `CatalogModule`, NestJS will throw a circular dependency error. Resolution: `InstalledService` takes `CatalogService` as a direct dependency (inject `CatalogService` into `InstalledService`), and `CatalogController` injects `InstalledService` directly. `CatalogModule` does NOT import `InstalledModule`; instead the enrichment controller lives in `InstalledModule` or a separate module.

**Recommended clean separation:** Move enrichment responsibility to a new `InstalledController` that handles both `GET /api/installed` and enrichment for the catalog. The existing `CatalogController` at `/api/apps` calls `InstalledService.enrichAll()` — OR, simpler: add a `GET /api/installed` only, and keep `CatalogController` calling `InstalledService.enrich()` directly with `InstalledService` injected into `CatalogModule` via a forward reference.

The simplest module topology that avoids circularity:

```
InstalledModule provides: GogsService, FluxStatusService, InstalledService
CatalogModule imports InstalledModule → CatalogService gets InstalledService injected
AppModule imports both
```

### RBAC Manifest (Design for Phase 5 Application)

```yaml
# Source: Kubernetes RBAC docs + FluxCD CRD group names confirmed from codebase
# [VERIFIED: CRD groups from app metadata.yaml templates]

apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: marketplace-ui-fluxcd-reader
rules:
  - apiGroups:
      - kustomize.toolkit.fluxcd.io
    resources:
      - kustomizations
    verbs:
      - get
      - list
      - watch
  - apiGroups:
      - helm.toolkit.fluxcd.io
    resources:
      - helmreleases
    verbs:
      - get
      - list
      - watch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: marketplace-ui-fluxcd-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: marketplace-ui-fluxcd-reader
subjects:
  - kind: ServiceAccount
    name: marketplace-ui
    namespace: marketplace-ui  # Pod's namespace (Phase 5 determines actual ns)
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@kubernetes/client-node` v0.x (callback style) | v1.x (promise-based, TypeScript-first) | 2023 | All API calls are async/await compatible; no callback hell |
| Gogs contents API (`/contents/:path`, base64) | Gogs raw API (`/raw/:ref/:path`, plain text) | Gogs v0.12+ | Raw endpoint returns file directly; simpler to parse |
| FluxCD v1beta1 Kustomization | FluxCD v1 Kustomization | 2023 | API group stays `kustomize.toolkit.fluxcd.io`, version upgraded to `v1` |
| FluxCD HelmRelease `helm.toolkit.fluxcd.io/v2beta1` | `helm.toolkit.fluxcd.io/v2` | FluxCD v2.3 | Use `v2` — confirmed in `open-webui/metadata.yaml` template |

**Deprecated/outdated:**
- `@kubernetes/client-node` callback APIs: replaced by promise-based equivalents in v1.x — do not use `.then().catch()` callback pattern examples from old tutorials
- `helm.toolkit.fluxcd.io/v2beta1` for HelmRelease: use `v2` — confirmed in `apps/open-webui/metadata.yaml`

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The root kustomization.yaml in the user-apps Gogs repo has `resources:` entries in format `appname/` (directory-reference style) | GogsService Pattern | If it uses a different format (e.g., file paths), the name extraction logic fails silently |
| A2 | All marketplace-managed FluxCD resources reside in `flux-system` namespace | FluxStatusService Pattern | If CRDs are in other namespaces, label-selector queries miss them and all apps show `installing` |
| A3 | The dev cluster kubeconfig is not present at the standard path — local dev must use fallback | Pitfall 5 | If cluster is available locally, `loadFromDefault()` works; if not, FluxStatusService returns `installing` for all — acceptable degradation |
| A4 | `CatalogService` is safe to inject into `InstalledService` without circular dependency once module topology is designed as described | Module Registration | If NestJS detects a cycle, need `forwardRef()` — but the proposed topology avoids this |

**Items verified (not assumed):**
- Gogs URL: `http://gogs.gogs.svc.cluster.local:80` — confirmed from `infrastructure/user-apps-source/gitrepository.yaml` [VERIFIED: codebase]
- Gogs repo owner `flux`, repo `user-apps` — confirmed from same file [VERIFIED: codebase]
- All app templates use label `marketplace.io/app: {appname}` — verified across all 20 apps [VERIFIED: codebase]
- FluxCD Kustomization group `kustomize.toolkit.fluxcd.io/v1` — confirmed from app templates [VERIFIED: codebase]
- FluxCD HelmRelease group `helm.toolkit.fluxcd.io/v2` — confirmed from `open-webui/metadata.yaml` [VERIFIED: codebase]
- `@kubernetes/client-node` version 1.4.0 [VERIFIED: npm registry]
- `js-yaml` already in server package.json [VERIFIED: codebase]
- `marketplace.io/app` label present in every app's template [VERIFIED: codebase — 20/20 apps]

---

## Open Questions (RESOLVED)

1. **User-apps Gogs repo structure — validated against live cluster?**
   - What we know: The root `kustomization.yaml` with `resources:` list is the decision (D-03). The format comes from what Phase 4 will write.
   - What's unclear: Since Phase 4 (install) hasn't been implemented yet, there may be NO installed apps in the dev cluster's Gogs instance. The kustomization.yaml may not exist yet.
   - RESOLVED: GogsService must handle the case where the file returns 404 (no apps installed yet) — return `[]` gracefully. This is already handled by the `if (!res.ok) return []` guard.

2. **Concurrent enrichment performance**
   - What we know: 12 user-facing apps, each potentially needing 2 CRD queries (Kustomization + HelmRelease). With `Promise.all()`, that is up to 24 concurrent k8s API calls.
   - What's unclear: Whether the dev cluster's k8s API rate-limits at this concurrency level.
   - RESOLVED: Only installed apps need CRD queries (not all 12). If no apps are installed (Phase 3 dev state), zero k8s calls are made. Safe for Phase 3.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js 22 | Runtime | ✓ | v22.22.2 | — |
| npm | Package management | ✓ | 11.6.2 | — |
| `@kubernetes/client-node` | FluxStatusService | ✗ (not installed) | — | Install: `npm install @kubernetes/client-node` |
| `js-yaml` | GogsService (kustomization.yaml parse) | ✓ (installed) | 4.1.1 | — |
| Dev k8s cluster | FluxStatusService local testing | ✗ | — | FluxStatusService falls back to `installing` for all apps; no cluster needed for unit tests |
| Gogs instance | GogsService local testing | ✗ | — | Unit tests mock GogsService; integration tests skip |

**Missing dependencies with no fallback:**
- `@kubernetes/client-node` must be installed before FluxStatusService can compile.

**Missing dependencies with fallback:**
- Dev cluster not accessible — FluxStatusService gracefully returns `'installing'` for all apps when k8s API is unreachable. No blocking.
- Gogs instance not accessible locally — GogsService returns `[]` (no installed apps). No blocking.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 2.x (server: `src/**/*.spec.ts`; client: `src/**/*.test.tsx`) |
| Server config | `ui/packages/server/vitest.config.ts` |
| Client config | `ui/packages/client/vitest.config.ts` |
| Server quick run | `cd ui/packages/server && npm test` |
| Client quick run | `cd ui/packages/client && npm test` |
| Full suite | `cd ui && npm test` (runs both packages) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BACK-02 | `GogsService.getInstalledAppNames()` returns names from kustomization.yaml resources | unit | `npm test -- --reporter=verbose installed/gogs.service.spec.ts` | ❌ Wave 0 |
| BACK-02 | `GogsService.getInstalledAppNames()` returns `[]` on Gogs 404/error | unit | same file | ❌ Wave 0 |
| BACK-03 | `FluxStatusService.getStatusFor()` returns `running` when Ready=True | unit | `npm test -- flux-status.service.spec.ts` | ❌ Wave 0 |
| BACK-03 | `FluxStatusService.getStatusFor()` returns `installing` when Reconciling=True | unit | same file | ❌ Wave 0 |
| BACK-03 | `FluxStatusService.getStatusFor()` returns `error` when Ready=False | unit | same file | ❌ Wave 0 |
| BACK-03 | `FluxStatusService.getStatusFor()` returns `installing` on k8s API error | unit | same file | ❌ Wave 0 |
| BACK-02+03 | `GET /api/apps` response includes `installedStatus` field on each app | e2e | `npm run test:e2e` | ❌ Wave 0 (extend existing catalog.e2e-spec.ts) |
| INST-03 | `GET /api/installed` returns only apps with installedStatus != not_installed | e2e | `npm run test:e2e` | ❌ Wave 0 |
| STAT-01 | `AppCard` renders StatusBadge when installedStatus is running/installing/error | unit | `cd ui/packages/client && npm test` | ❌ Wave 0 |
| STAT-01 | `AppCard` does NOT render StatusBadge when installedStatus is not_installed | unit | same | ❌ Wave 0 |
| INST-03 | `MyAppsPage` renders AppCard grid for installed apps | unit | same | ❌ Wave 0 |
| INST-03 | `MyAppsPage` renders empty state when no apps installed | unit | same | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cd /home/alex/code/librepod/marketplace/ui/packages/server && npm test` (server unit) OR `cd /home/alex/code/librepod/marketplace/ui/packages/client && npm test` (client unit)
- **Per wave merge:** Both server and client test suites green
- **Phase gate:** All unit + e2e tests green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `ui/packages/server/src/installed/gogs.service.spec.ts` — covers BACK-02 (mock fetch)
- [ ] `ui/packages/server/src/installed/flux-status.service.spec.ts` — covers BACK-03 (mock CustomObjectsApi)
- [ ] `ui/packages/server/src/installed/installed.service.spec.ts` — covers enrichment composition
- [ ] Extend `ui/packages/server/test/catalog.e2e-spec.ts` — add `installedStatus` field assertion
- [ ] `ui/packages/server/test/catalog.e2e-spec.ts` — add `GET /api/installed` endpoint e2e test
- [ ] `ui/packages/client/src/components/StatusBadge.test.tsx` — covers STAT-01
- [ ] `ui/packages/client/src/pages/MyAppsPage.test.tsx` — covers INST-03

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No user auth in v1 (project-wide decision) |
| V3 Session Management | no | No sessions in v1 |
| V4 Access Control | yes (internal) | ServiceAccount + ClusterRole — least privilege, get/list/watch only on FluxCD CRDs |
| V5 Input Validation | yes | App name from URL param validated against catalog before k8s lookup; never interpolated into shell commands |
| V6 Cryptography | no | Gogs token transmitted over HTTP (internal cluster network only — `*.svc.cluster.local`) |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| GOGS_TOKEN leakage via pod env var | Information Disclosure | Token stored as Kubernetes Secret, mounted as env var — not in code or configmap |
| Over-privileged ServiceAccount | Elevation of Privilege | ClusterRole limited to `get`, `list`, `watch` on Kustomizations + HelmReleases only — no write access, no pod/node access |
| URL injection in Gogs API path | Tampering | `appName` sourced from catalog (controlled list), not from raw URL param — no user-controlled strings in Gogs API path |
| k8s API token exposure in logs | Information Disclosure | `loadFromCluster()` reads token from mounted file, never logs it — NestJS Logger must not log env vars |

---

## Sources

### Primary (HIGH confidence)
- `marketplace/infrastructure/user-apps-source/gitrepository.yaml` — Gogs URL, repo owner/name confirmed [VERIFIED: codebase]
- `marketplace/apps/*/metadata.yaml` (20 apps) — `marketplace.io/app` label pattern, CRD group/version/kind confirmed [VERIFIED: codebase]
- Context7 `/kubernetes-client/javascript` — `CustomObjectsApi`, `KubeConfig.loadFromCluster()`, `listNamespacedCustomObject` [VERIFIED: Context7]
- `ui/packages/server/src/catalog/catalog.service.ts` — NestJS DI and ConfigService patterns [VERIFIED: codebase]
- `ui/packages/client/src/components/AppCard.tsx` — existing card layout for badge overlay [VERIFIED: codebase]

### Secondary (MEDIUM confidence)
- [FluxCD Kustomization status docs](https://fluxcd.io/flux/components/kustomize/kustomizations/) — condition types `Ready`, `Reconciling`, `Stalled` [CITED: fluxcd.io]
- [Gogs docs-api Contents.md](https://github.com/gogs/docs-api/blob/master/Repositories/Contents.md) — raw file endpoint `GET /api/v1/repos/:user/:repo/raw/:ref/:path` [CITED: github.com/gogs/docs-api]

### Tertiary (LOW confidence)
- None — all critical claims verified via codebase or official documentation.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `@kubernetes/client-node` is official, version verified; all other deps already installed
- Architecture: HIGH — module topology mirrors existing NestJS patterns; CRD names/labels verified in codebase
- Pitfalls: HIGH — all pitfalls are specific to verified technology behaviors or confirmed codebase patterns
- Test map: HIGH — mirrors existing spec/test patterns from Phases 1 and 2

**Research date:** 2026-04-21
**Valid until:** 2026-05-21 (stable stack; FluxCD CRD API versions unlikely to change)
