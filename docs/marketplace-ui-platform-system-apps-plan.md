# Marketplace UI — Platform / System-Apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop platform/system apps from appearing user-installable, and instead show them read-only with live health in a Platform panel — fixing the forever-"Installing" badge for apps like frp-operator.

**Architecture:** Derive "system-managed" per cluster at runtime from the live `system-apps` Flux Kustomization: list flux-system `OCIRepository`s carrying the `kustomize.toolkit.fluxcd.io/name=system-apps` parent label, parse each `spec.url` (`oci://…/apps/<catalog-name>`) for the catalog app name, and remember the paired Flux object name for status. A new `SystemAppsService` owns this; `enrich` classifies system apps first (before the Gogs "installed?" check), `/api/apps` excludes them, a new `/api/system-apps` feeds a read-only Platform panel on `/`, and `getStatusFor` gains a system branch that reads the Kustomization by name. No `metadata.yaml` or `catalog.yaml` changes.

**Tech Stack:** NestJS 11 (server), React 19 + TanStack Query + react-router (client), `@kubernetes/client-node` (k8s), vitest (unit), Playwright (e2e). Type-only `@librepod/shared`.

## Global Constraints

- Run all `ui/` commands from the workspace root `ui/` directory.
- `@librepod/shared` is type-only (raw `.ts`, no build) — adding a field is a type change only.
- Catalog/e2e hermetic pattern: tests pin `KUBECONFIG` to a closed port and point `CATALOG_PATH` at a fixture; the new `SYSTEM_APPS_OVERRIDE` env follows this same stubbing philosophy.
- k8s calls use `@kubernetes/client-node` object-arg style: `listNamespacedCustomObject({ group, version, namespace, plural, labelSelector })`, `getNamespacedCustomObject({ group, version, namespace, plural, name })`.
- Commit/PR hygiene: never reference concrete device/cluster hostnames (use `dev`/`prod`). Commit messages follow existing scoped style: `feat(ui):`, `fix(ui):`, `test(ui):`, `docs(ui):`, `refactor(ui):`.
- Frequent commits — one logical change per task, TDD (failing test first).

## File Structure

**Server (`ui/packages/server/src/`):**
- `shared/src/types.ts` — add `system?: boolean` to `CatalogApp` (runtime-enriched, not in catalog.yaml).
- `installed/system-apps.service.ts` — **NEW.** Owns "which apps does this cluster manage." `getSystemApps(): Promise<Map<string,string>>` (catalog name → Flux Kustomization object name), `isSystem(name): Promise<boolean>`. Cached (~30s), `SYSTEM_APPS_OVERRIDE` test seam, graceful degradation.
- `installed/system-apps.service.spec.ts` — **NEW.**
- `installed/flux-status.service.ts` — modify: `getStatusFor(appName, opts?)` system branch + reorder `Ready=False` before `Reconciling` in `deriveStatusFromConditions`.
- `installed/flux-status.service.spec.ts` — extend.
- `installed/installed.service.ts` — modify: inject `SystemAppsService`; `enrich` classifies system first; `getInstalled` excludes system; new `getSystemApps()`; install/uninstall 409 guard.
- `installed/installed.service.spec.ts` — extend (add `SystemAppsService` mock).
- `installed/system-apps.controller.ts` — **NEW.** `@Controller('system-apps')` → `GET /` returns `getSystemApps()`.
- `installed/installed.module.ts` — register `SystemAppsService` + `SystemAppsController`.
- `catalog/catalog.controller.ts` — modify: `findAll` filters out `system` apps.

**Client (`ui/packages/client/src/`):**
- `hooks/useSystemApps.ts` — **NEW.** `react-query` key `['system-apps']` → `GET /api/system-apps`.
- `components/PlatformPanel.tsx` — **NEW.** Collapsible, read-only health list of system apps.
- `components/PlatformPanel.test.tsx` — **NEW.**
- `pages/MyAppsPage.tsx` — render `<PlatformPanel />`.
- `pages/AppDetailPage.tsx` — system treatment (Managed-by-platform badge, hide Install/Uninstall/Open).
- `pages/AppDetailPage.test.tsx` — extend.

**E2E (`ui/packages/e2e/`):**
- `projects/tier1.config.ts` — add `SYSTEM_APPS_OVERRIDE` env.
- `tests/app-level/platform.spec.ts` — **NEW.**

**Docs:**
- `ui/CLAUDE.md` — document `SystemAppsService`, `/api/system-apps`, the `system` flag, Platform panel.

---

### Task 1: Add `system` field to the shared `CatalogApp` type

**Files:**
- Modify: `ui/packages/shared/src/types.ts`

**Interfaces:**
- Produces: `CatalogApp.system?: boolean` — consumed by every later task.

- [ ] **Step 1: Add the field**

In `ui/packages/shared/src/types.ts`, inside `export interface CatalogApp {`, add `system?: boolean;` next to `installedStatus?:`:

```ts
  sourceType: string;
  sourceUrl: string;
  installedStatus?: AppStatus;
  system?: boolean;          // runtime-derived, per-cluster; absent/false = user app
  templates?: AppTemplate;
```

- [ ] **Step 2: Verify it compiles in both consumers**

Run from `ui/`:
```bash
npm run build:client
```
Expected: build succeeds (shared is consumed via Vite; a new optional field cannot break it).

```bash
npm run build --workspace=packages/server
```
Expected: `nest build` succeeds.

- [ ] **Step 3: Commit**

```bash
git add ui/packages/shared/src/types.ts
git commit -m "feat(ui): add system flag to CatalogApp type"
```

---

### Task 2: `SystemAppsService` — derive managed apps from the cluster

**Files:**
- Create: `ui/packages/server/src/installed/system-apps.service.ts`
- Test: `ui/packages/server/src/installed/system-apps.service.spec.ts`

**Interfaces:**
- Produces:
  - `getSystemApps(): Promise<Map<string, string>>` — catalog app name → Flux Kustomization object name (e.g. `'nfs-provisioner' → 'storage'`, `'frp-operator' → 'frp-operator'`).
  - `isSystem(name: string): Promise<boolean>`.
- Consumes: `@kubernetes/client-node` `CustomObjectsApi`; env `SYSTEM_APPS_OVERRIDE`.

- [ ] **Step 1: Confirm the detection signal on a live cluster (the one verification item)**

Run against the dev kubeconfig:
```bash
kubectl --kubeconfig ./librepod-dev.config get ocirepository -n flux-system \
  -l kustomize.toolkit.fluxcd.io/name=system-apps \
  -o custom-columns=NAME:.metadata.name,URL:.spec.url
```
Expected: a table of the system apps' OCIRepositories (e.g. `casdoor`, `traefik`, `storage`, …) each with a URL `oci://ghcr.io/librepod/marketplace/apps/<name>`. If this returns `No resources found`, the parent label is NOT applied to OCIRepositories; fall back to joining the `system-apps` Kustomization `.status.inventory` (object names) with the OCIRepository URLs by object name. Record the result; the implementation below assumes the label is present (verified behavior).

- [ ] **Step 2: Write the failing test**

Create `ui/packages/server/src/installed/system-apps.service.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { SystemAppsService } from './system-apps.service';

const mockList = vi.fn();
vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    loadFromCluster: vi.fn(),
    loadFromDefault: vi.fn(),
    makeApiClient: vi.fn().mockReturnValue({
      listNamespacedCustomObject: mockList,
    }),
  })),
  CustomObjectsApi: vi.fn(),
}));

function ociRepo(name: string, url: string) {
  return { metadata: { name }, spec: { url } };
}

describe('SystemAppsService', () => {
  let service: SystemAppsService;
  let module: TestingModule;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.SYSTEM_APPS_OVERRIDE;
    module = await Test.createTestingModule({ providers: [SystemAppsService] }).compile();
    service = module.get(SystemAppsService);
    await module.init();
  });

  afterEach(async () => {
    await module.close();
  });

  it('maps OCIRepository URLs to catalog names, keeping the Flux object name', async () => {
    mockList.mockResolvedValueOnce({
      items: [
        ociRepo('frp-operator', 'oci://ghcr.io/librepod/marketplace/apps/frp-operator'),
        // Object named "storage" but app is "nfs-provisioner" (the mismatch case)
        ociRepo('storage', 'oci://ghcr.io/librepod/marketplace/apps/nfs-provisioner'),
      ],
    });

    const map = await service.getSystemApps();

    expect(map.get('frp-operator')).toBe('frp-operator');
    expect(map.get('nfs-provisioner')).toBe('storage');
  });

  it('isSystem returns true for a managed app, false otherwise', async () => {
    mockList.mockResolvedValueOnce({
      items: [ociRepo('gogs', 'oci://ghcr.io/librepod/marketplace/apps/gogs')],
    });

    expect(await service.isSystem('gogs')).toBe(true);
    expect(await service.isSystem('vaultwarden')).toBe(false);
  });

  it('SYSTEM_APPS_OVERRIDE replaces the cluster query (test seam)', async () => {
    process.env.SYSTEM_APPS_OVERRIDE = JSON.stringify([
      { name: 'gogs', kustomization: 'gogs' },
    ]);

    const map = await service.getSystemApps();

    expect(map.get('gogs')).toBe('gogs');
    expect(mockList).not.toHaveBeenCalled();
  });

  it('caches the result across calls within TTL', async () => {
    mockList.mockResolvedValueOnce({ items: [ociRepo('gogs', 'oci://ghcr.io/librepod/marketplace/apps/gogs')] });

    await service.getSystemApps();
    await service.getSystemApps();

    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('returns empty map on k8s error (cold start), without throwing', async () => {
    mockList.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const map = await service.getSystemApps();

    expect(map.size).toBe(0);
  });

  it('queries flux-system ocirepositories with the system-apps parent label', async () => {
    mockList.mockResolvedValueOnce({ items: [] });

    await service.getSystemApps();

    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'source.toolkit.fluxcd.io',
        version: 'v1',
        namespace: 'flux-system',
        plural: 'ocirepositories',
        labelSelector: 'kustomize.toolkit.fluxcd.io/name=system-apps',
      }),
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run from `ui/`:
```bash
npm test --workspace=packages/server -- src/installed/system-apps.service.spec.ts
```
Expected: FAIL — `Cannot find module './system-apps.service'`.

- [ ] **Step 4: Write the implementation**

Create `ui/packages/server/src/installed/system-apps.service.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node';

const SYSTEM_APPS_TTL_MS = 30_000;

interface OverrideEntry {
  name: string;
  kustomization: string;
}

@Injectable()
export class SystemAppsService implements OnModuleInit {
  private readonly logger = new Logger(SystemAppsService.name);
  private customObjectsApi!: CustomObjectsApi;
  private cache: { map: Map<string, string>; expiresAt: number } | null = null;

  onModuleInit(): void {
    const kc = new KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    this.customObjectsApi = kc.makeApiClient(CustomObjectsApi);
  }

  /**
   * Catalog app name → the Flux Kustomization object name that reconciles it
   * on THIS cluster (e.g. 'nfs-provisioner' → 'storage'). Derived from the
   * OCIRepositories the system-apps Kustomization manages, so it is
   * flavour-correct and auto-tracks swaps with no per-app metadata.
   */
  async getSystemApps(): Promise<Map<string, string>> {
    // Test seam + hermetic determinism: an explicit override replaces the query.
    const override = process.env.SYSTEM_APPS_OVERRIDE;
    if (override) {
      try {
        const parsed = JSON.parse(override) as OverrideEntry[];
        return new Map(parsed.map((e) => [e.name, e.kustomization]));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`SYSTEM_APPS_OVERRIDE set but invalid JSON, ignoring: ${message}`);
      }
    }

    if (this.cache && Date.now() < this.cache.expiresAt) {
      return this.cache.map;
    }

    const map = await this.queryCluster();
    this.cache = { map, expiresAt: Date.now() + SYSTEM_APPS_TTL_MS };
    return map;
  }

  async isSystem(name: string): Promise<boolean> {
    return (await this.getSystemApps()).has(name);
  }

  private async queryCluster(): Promise<Map<string, string>> {
    try {
      const resp = (await this.customObjectsApi.listNamespacedCustomObject({
        group: 'source.toolkit.fluxcd.io',
        version: 'v1',
        namespace: 'flux-system',
        plural: 'ocirepositories',
        labelSelector: 'kustomize.toolkit.fluxcd.io/name=system-apps',
      })) as { items?: Array<{ metadata?: { name?: string }; spec?: { url?: string } }> };

      const map = new Map<string, string>();
      for (const item of resp.items ?? []) {
        const url = item.spec?.url;
        const objName = item.metadata?.name;
        if (!url || !objName) continue;
        const app = this.parseAppFromUrl(url);
        if (app) map.set(app, objName);
      }
      return map;
    } catch (error: unknown) {
      // Graceful degradation: keep last-known if we have it, else empty.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `k8s API unreachable for system-apps, returning ${this.cache ? 'cached' : 'empty'}: ${message}`,
      );
      return this.cache?.map ?? new Map();
    }
  }

  // `oci://ghcr.io/librepod/marketplace/apps/<catalog-name>` → `<catalog-name>`.
  // The URL is the canonical app identity; the Flux object name is arbitrary.
  private parseAppFromUrl(url: string): string | undefined {
    const marker = '/apps/';
    const idx = url.lastIndexOf(marker);
    if (idx < 0) return undefined;
    const app = url.slice(idx + marker.length).trim();
    return app || undefined;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test --workspace=packages/server -- src/installed/system-apps.service.spec.ts
```
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add ui/packages/server/src/installed/system-apps.service.ts ui/packages/server/src/installed/system-apps.service.spec.ts
git commit -m "feat(ui): add SystemAppsService deriving managed apps from cluster"
```

---

### Task 3: `FluxStatusService` — system branch + condition precedence

**Files:**
- Modify: `ui/packages/server/src/installed/flux-status.service.ts`
- Test: `ui/packages/server/src/installed/flux-status.service.spec.ts`

**Interfaces:**
- Produces: `getStatusFor(appName: string, opts?: { systemKustomization?: string }): Promise<AppStatus>`. For user apps (no opts) behavior is unchanged.
- Consumes: nothing new.

- [ ] **Step 1: Add `getNamespacedCustomObject` to the test's k8s mock**

In `flux-status.service.spec.ts`, update the `vi.mock('@kubernetes/client-node', …)` block so `makeApiClient` also returns `getNamespacedCustomObject`:

```ts
const mockListNamespacedCustomObject = vi.fn();
const mockGetNamespacedCustomObject = vi.fn();
vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    loadFromCluster: vi.fn(),
    loadFromDefault: vi.fn(),
    makeApiClient: vi.fn().mockReturnValue({
      listNamespacedCustomObject: mockListNamespacedCustomObject,
      getNamespacedCustomObject: mockGetNamespacedCustomObject,
    }),
  })),
  CustomObjectsApi: vi.fn(),
}));
```

- [ ] **Step 2: Write the failing tests (system branch + precedence)**

Add a new `describe('getStatusFor(appName, { systemKustomization })', …)` block and a precedence test inside the existing `describe('getStatusFor(appName)', …)` (or as siblings). Append before the closing `});` of the top-level `describe('FluxStatusService', …)`:

```ts
    it('Ready=False beats Reconciling=True (precedence fix)', async () => {
      mockListNamespacedCustomObject.mockResolvedValueOnce(
        makeConditions([
          { type: 'Ready', status: 'False' },
          { type: 'Reconciling', status: 'True' },
        ]),
      );

      const status = await service.getStatusFor('vaultwarden');

      expect(status).toBe('error');
    });

    it('Ready=True with Reconciling=True resolves to running', async () => {
      mockListNamespacedCustomObject.mockResolvedValueOnce(
        makeConditions([
          { type: 'Ready', status: 'True' },
          { type: 'Reconciling', status: 'True' },
        ]),
      );

      const status = await service.getStatusFor('vaultwarden');

      expect(status).toBe('running');
    });
  });

  describe('getStatusFor(appName, { systemKustomization })', () => {
    it('queries the named Kustomization and returns running when Ready=True', async () => {
      mockGetNamespacedCustomObject.mockResolvedValueOnce({
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      });

      // nfs-provisioner's Flux object is named "storage"
      const status = await service.getStatusFor('nfs-provisioner', {
        systemKustomization: 'storage',
      });

      expect(status).toBe('running');
      expect(mockGetNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'kustomize.toolkit.fluxcd.io',
          version: 'v1',
          namespace: 'flux-system',
          plural: 'kustomizations',
          name: 'storage',
        }),
      );
      // Must NOT use the marketplace label query for system apps.
      expect(mockListNamespacedCustomObject).not.toHaveBeenCalled();
    });

    it('returns installing on k8s error (graceful degradation)', async () => {
      mockGetNamespacedCustomObject.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const status = await service.getStatusFor('frp-operator', {
        systemKustomization: 'frp-operator',
      });

      expect(status).toBe('installing');
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test --workspace=packages/server -- src/installed/flux-status.service.spec.ts
```
Expected: FAIL — the precedence test gets `'installing'` (old order), and the system-branch tests fail because `getStatusFor` ignores the option.

- [ ] **Step 4: Implement the system branch + reorder precedence**

Replace `ui/packages/server/src/installed/flux-status.service.ts` with:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node';
import type { AppStatus, FluxCondition } from './installed.types';

@Injectable()
export class FluxStatusService implements OnModuleInit {
  private readonly logger = new Logger(FluxStatusService.name);
  private customObjectsApi!: CustomObjectsApi;

  onModuleInit(): void {
    const kc = new KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    this.customObjectsApi = kc.makeApiClient(CustomObjectsApi);
  }

  /**
   * Derive an app's health from Flux.
   * - User app (no opts): look up the marketplace-installed object by the
   *   `marketplace.io/app=<name>` label (Kustomization, then HelmRelease).
   * - System app ({ systemKustomization }): look up the cluster's platform
   *   Kustomization BY NAME (it has no marketplace label).
   */
  async getStatusFor(
    appName: string,
    opts?: { systemKustomization?: string },
  ): Promise<AppStatus> {
    if (opts?.systemKustomization) {
      return this.getStatusOfNamedKustomization(opts.systemKustomization);
    }
    return this.getStatusOfMarketplaceApp(appName);
  }

  private async getStatusOfMarketplaceApp(appName: string): Promise<AppStatus> {
    const labelSelector = `marketplace.io/app=${appName}`;
    try {
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

      return 'installing'; // CRD not found yet — propagation lag after Gogs commit
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`k8s API unreachable for ${appName}, returning installing: ${message}`);
      return 'installing';
    }
  }

  private async getStatusOfNamedKustomization(name: string): Promise<AppStatus> {
    try {
      const resp = (await this.customObjectsApi.getNamespacedCustomObject({
        group: 'kustomize.toolkit.fluxcd.io',
        version: 'v1',
        namespace: 'flux-system',
        plural: 'kustomizations',
        name,
      })) as { status?: { conditions?: FluxCondition[] } };
      return this.deriveStatusFromConditions(resp.status?.conditions ?? []);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`k8s API unreachable for system kustomization ${name}, returning installing: ${message}`);
      return 'installing';
    }
  }

  private deriveStatusFromConditions(conditions: FluxCondition[]): AppStatus {
    const ready = conditions.find((c) => c.type === 'Ready');
    const reconciling = conditions.find((c) => c.type === 'Reconciling');
    if (ready?.status === 'True') return 'running';
    // Ready=False must beat Reconciling=True: a degraded object that is also
    // retrying should read as Error, not a forever-yellow "Installing".
    if (ready?.status === 'False') return 'error';
    if (reconciling?.status === 'True') return 'installing';
    return 'installing';
  }
}
```

- [ ] **Step 5: Run the full flux-status spec to verify all pass**

```bash
npm test --workspace=packages/server -- src/installed/flux-status.service.spec.ts
```
Expected: PASS (existing 8 + new 4 = 12 tests). The old test `returns "installing" when Kustomization has Reconciling=True` still passes (no Ready condition present).

- [ ] **Step 6: Commit**

```bash
git add ui/packages/server/src/installed/flux-status.service.ts ui/packages/server/src/installed/flux-status.service.spec.ts
git commit -m "fix(ui): derive system-app status by name; Ready=False beats Reconciling"
```

---

### Task 4: `InstalledService` — enrich precedence, `getSystemApps`, install/uninstall 409

**Files:**
- Modify: `ui/packages/server/src/installed/installed.service.ts`
- Test: `ui/packages/server/src/installed/installed.service.spec.ts`

**Interfaces:**
- Consumes: `SystemAppsService.getSystemApps()` / `.isSystem(name)` (Task 2), `FluxStatusService.getStatusFor(name, opts?)` (Task 3).
- Produces:
  - `enrich(apps)` now sets `system: true` on managed apps and routes their status through the system branch.
  - `getSystemApps(): Promise<CatalogApp[]>` — enriched managed apps.
  - `getInstalled()` now also excludes system apps.
  - `install`/`uninstall` throw `ConflictException` (409) for managed apps.

- [ ] **Step 1: Write the failing tests**

In `installed.service.spec.ts`, add a `SystemAppsService` mock and wire it into the constructor. Update the `beforeEach`:

```ts
import { SystemAppsService } from './system-apps.service';
// ...
  let mockSystemAppsService: {
    getSystemApps: ReturnType<typeof vi.fn>;
    isSystem: ReturnType<typeof vi.fn>;
  };
// ...inside beforeEach, after the other mocks:
    mockSystemAppsService = {
      getSystemApps: vi.fn().mockResolvedValue(new Map()),
      isSystem: vi.fn().mockResolvedValue(false),
    };
// ...and change the `new InstalledService(...)` call to pass it as a 5th arg:
    service = new InstalledService(
      mockCatalogService as unknown as CatalogService,
      mockGogsService as unknown as GogsService,
      mockFluxService as unknown as FluxStatusService,
      mockConfigService,
      mockSystemAppsService as unknown as SystemAppsService,
    );
```

Then add these test blocks (inside the top-level `describe('InstalledService', …)`):

```ts
  describe('enrich() system classification', () => {
    it('marks a managed app system:true and derives status from the system branch', async () => {
      mockSystemAppsService.getSystemApps.mockResolvedValue(
        new Map([['gogs', 'gogs']]),
      );
      // gogs must be classified system BEFORE the Gogs check is consulted
      mockGogsService.getInstalledAppNames.mockResolvedValue(['gogs']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const enriched = await service.enrich(mockCatalogApps);

      const gogs = enriched.find((a) => a.name === 'gogs')!;
      expect(gogs.system).toBe(true);
      expect(gogs.installedStatus).toBe('running');
      expect(mockFluxService.getStatusFor).toHaveBeenCalledWith('gogs', {
        systemKustomization: 'gogs',
      });
    });

    it('resolves the original bug: frp-operator classified system → running, not installing', async () => {
      const frp = { ...mockCatalogApps[0], name: 'frp-operator', displayName: 'FRP Operator' };
      mockSystemAppsService.getSystemApps.mockResolvedValue(
        new Map([['frp-operator', 'frp-operator']]),
      );
      mockGogsService.getInstalledAppNames.mockResolvedValue(['frp-operator']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const [enriched] = await service.enrich([frp]);

      expect(enriched.system).toBe(true);
      expect(enriched.installedStatus).toBe('running');
    });

    it('leaves a user app system:false and uses the marketplace label query', async () => {
      mockSystemAppsService.getSystemApps.mockResolvedValue(new Map());
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const enriched = await service.enrich(mockCatalogApps);

      const vw = enriched.find((a) => a.name === 'vaultwarden')!;
      expect(vw.system).toBeFalsy();
      expect(mockFluxService.getStatusFor).toHaveBeenCalledWith('vaultwarden');
    });
  });

  describe('getInstalled()', () => {
    it('excludes system apps', async () => {
      mockSystemAppsService.getSystemApps.mockResolvedValue(
        new Map([['gogs', 'gogs']]),
      );
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden', 'gogs']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const installed = await service.getInstalled();

      expect(installed.map((a) => a.name)).toEqual(['vaultwarden']);
    });
  });

  describe('install() / uninstall() managed-app guard', () => {
    it('install throws ConflictException for a managed app', async () => {
      mockSystemAppsService.isSystem.mockResolvedValue(true);

      await expect(service.install('gogs')).rejects.toThrow(/managed by the platform/);
      expect(mockGogsService.createFile).not.toHaveBeenCalled();
    });

    it('uninstall throws ConflictException for a managed app', async () => {
      mockSystemAppsService.isSystem.mockResolvedValue(true);

      await expect(service.uninstall('gogs')).rejects.toThrow(/managed by the platform/);
      expect(mockGogsService.removeFromRootKustomization).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test --workspace=packages/server -- src/installed/installed.service.spec.ts
```
Expected: FAIL — `InstalledService` constructor arity mismatch (no SystemAppsService) and missing system behavior.

- [ ] **Step 3: Implement the changes**

In `ui/packages/server/src/installed/installed.service.ts`:

Add the import and constructor param:
```ts
import { SystemAppsService } from './system-apps.service';
// ...
  constructor(
    private readonly catalog: CatalogService,
    private readonly gogs: GogsService,
    private readonly flux: FluxStatusService,
    private readonly configService: ConfigService,
    private readonly systemApps: SystemAppsService,
  ) {}
```

Replace the `enrich` method:
```ts
  async enrich(apps: CatalogApp[]): Promise<CatalogApp[]> {
    const [installedNames, systemMap] = await Promise.all([
      this.gogs.getInstalledAppNames(),
      this.systemApps.getSystemApps(),
    ]);
    const installedSet = new Set(installedNames);
    return Promise.all(
      apps.map(async (app) => {
        // System classification wins: a managed app's status comes from its
        // platform Flux object (by name), never the Gogs "installed?" check —
        // this is what stops the forever-"Installing" badge for apps like
        // frp-operator that are both system-managed and present in user-apps.
        const systemKustomization = systemMap.get(app.name);
        if (systemKustomization) {
          const status = await this.flux.getStatusFor(app.name, { systemKustomization });
          return { ...app, system: true, installedStatus: status };
        }
        if (!installedSet.has(app.name)) {
          return { ...app, installedStatus: 'not_installed' as const };
        }
        const status = await this.flux.getStatusFor(app.name);
        return { ...app, installedStatus: status };
      }),
    );
  }
```

Replace `getInstalled` and add `getSystemApps`:
```ts
  async getInstalled(): Promise<CatalogApp[]> {
    const all = await this.enrich(this.catalog.findAll());
    return all.filter(
      (app) => app.installedStatus !== 'not_installed' && !app.system,
    );
  }

  async getSystemApps(): Promise<CatalogApp[]> {
    const all = await this.enrich(this.catalog.findAll());
    return all.filter((app) => app.system);
  }
```

Add the managed-app guard at the top of `install` (after the `app` is resolved, before the "already installed" check) and `uninstall` (after the `app` is resolved, before the "is installed" check):

In `install`, after `if (!app.templates) throw …;`:
```ts
      // Managed apps are read-only platform components.
      if (await this.systemApps.isSystem(appName)) {
        throw new ConflictException(
          `${app.displayName} is managed by the platform and cannot be installed`,
        );
      }
```

In `uninstall`, after `const app = this.catalog.findOne(appName); if (!app) throw …;`:
```ts
      if (await this.systemApps.isSystem(appName)) {
        throw new ConflictException(
          `${app.displayName} is managed by the platform and cannot be uninstalled`,
        );
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test --workspace=packages/server -- src/installed/installed.service.spec.ts
```
Expected: PASS (all existing + new tests). The existing `enrich()` tests still pass because `mockSystemAppsService.getSystemApps` defaults to an empty Map.

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/installed/installed.service.ts ui/packages/server/src/installed/installed.service.spec.ts
git commit -m "feat(ui): classify system apps in enrich; reject install/uninstall (409)"
```

---

### Task 5: Wire the Nest module + controllers (`/api/system-apps`, `/api/apps` filter)

**Files:**
- Create: `ui/packages/server/src/installed/system-apps.controller.ts`
- Modify: `ui/packages/server/src/installed/installed.module.ts`
- Modify: `ui/packages/server/src/catalog/catalog.controller.ts`

**Interfaces:**
- Produces: `GET /api/system-apps` → enriched managed apps; `GET /api/apps` excludes managed apps.

- [ ] **Step 1: Create the controller**

Create `ui/packages/server/src/installed/system-apps.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { InstalledService } from './installed.service';
import type { CatalogApp } from '@librepod/shared';

@Controller('system-apps')
export class SystemAppsController {
  constructor(private readonly installedService: InstalledService) {}

  @Get()
  async findAll(): Promise<CatalogApp[]> {
    return this.installedService.getSystemApps();
  }
}
```

- [ ] **Step 2: Register the service + controller in the module**

In `ui/packages/server/src/installed/installed.module.ts`:

```ts
import { Module, forwardRef } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { InstalledController } from './installed.controller';
import { SystemAppsController } from './system-apps.controller';
import { InstalledService } from './installed.service';
import { GogsService } from './gogs.service';
import { FluxStatusService } from './flux-status.service';
import { SystemAppsService } from './system-apps.service';

@Module({
  imports: [forwardRef(() => CatalogModule)],
  controllers: [InstalledController, SystemAppsController],
  providers: [InstalledService, GogsService, FluxStatusService, SystemAppsService],
  exports: [InstalledService],
})
export class InstalledModule {}
```

- [ ] **Step 3: Exclude system apps from the Catalog endpoint**

In `ui/packages/server/src/catalog/catalog.controller.ts`, change `findAll`:

```ts
  @Get()
  async findAll(): Promise<CatalogApp[]> {
    const apps = this.catalogService.findAll();
    const enriched = await this.installedService.enrich(apps);
    return enriched.filter((app) => !app.system);
  }
```

- [ ] **Step 4: Build the server + run the full server test suite**

```bash
npm run build --workspace=packages/server
npm test --workspace=packages/server
```
Expected: clean build; all server unit tests pass. (The HTTP contract for `/api/apps` exclusion and `/api/system-apps` is exercised end-to-end in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/installed/system-apps.controller.ts ui/packages/server/src/installed/installed.module.ts ui/packages/server/src/catalog/catalog.controller.ts
git commit -m "feat(ui): add /api/system-apps endpoint; exclude managed apps from /api/apps"
```

---

### Task 6: Client `useSystemApps` hook + `PlatformPanel` component

**Files:**
- Create: `ui/packages/client/src/hooks/useSystemApps.ts`
- Create: `ui/packages/client/src/components/PlatformPanel.tsx`
- Test: `ui/packages/client/src/components/PlatformPanel.test.tsx`

**Interfaces:**
- Produces: `useSystemApps()` (react-query key `['system-apps']`); `<PlatformPanel />` (self-contained: own loading/error/empty).

- [ ] **Step 1: Write the hook**

Create `ui/packages/client/src/hooks/useSystemApps.ts`:

```ts
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { CatalogApp } from '@librepod/shared'

export function useSystemApps() {
  return useQuery<CatalogApp[]>({
    queryKey: ['system-apps'],
    queryFn: async () => {
      const res = await apiFetch('/api/system-apps')
      if (!res.ok) throw new Error('Failed to fetch system apps')
      return res.json()
    },
    retry: 0,
    // If a platform component is still reconciling, poll until it settles.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((a) => a.installedStatus === 'installing')
        ? 5000
        : false,
  })
}
```

- [ ] **Step 2: Write the failing component test**

Create `ui/packages/client/src/components/PlatformPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PlatformPanel } from './PlatformPanel'
import type { CatalogApp } from '@librepod/shared'

const systemApp: CatalogApp = {
  name: 'frp-operator',
  displayName: 'FRP Operator',
  description: 'FRP operator',
  category: 'Network',
  version: 'v0.9.0',
  icon: 'https://example.com/frp.png',
  sourceType: 'oci-kustomize',
  sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/frp-operator',
  system: true,
  installedStatus: 'running',
}

function withProviders(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('PlatformPanel', () => {
  it('renders system apps as read-only rows with a System tag and status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [systemApp],
    } as Response)

    render(withProviders(<PlatformPanel />))

    await waitFor(() => {
      expect(screen.getByText('FRP Operator')).toBeInTheDocument()
    })
    expect(screen.getByText('System')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    // No install affordance on a platform component
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument()
  })

  it('renders nothing for the list when no system apps are returned', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response)

    const { container } = render(withProviders(<PlatformPanel />))

    await waitFor(() => {
      expect(screen.getByText(/Platform/)).toBeInTheDocument()
    })
    expect(container.querySelector('ul')).toBeNull()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm run test --workspace=packages/client -- src/components/PlatformPanel.test.tsx
```
Expected: FAIL — `Cannot find module './PlatformPanel'`.

- [ ] **Step 4: Write the component**

Create `ui/packages/client/src/components/PlatformPanel.tsx`:

```tsx
import { Link } from "react-router-dom"
import { Lock } from "lucide-react"
import { useSystemApps } from "@/hooks/useSystemApps"
import { AppIcon } from "@/components/AppIcon"
import { StatusBadge } from "@/components/StatusBadge"
import { ErrorBlock } from "@/components/ErrorBlock"

/**
 * The platform's read-only health roster. System apps (traefik, casdoor, the
 * frp operator, …) are managed by the cluster, not user-installable, so they
 * live here as a status list — not launch tiles. Each row links to the app's
 * detail page (which renders "Managed by platform"). Collapsible via <details>
 * so ~14 infra components don't crowd the launcher.
 */
export function PlatformPanel() {
  const { isPending, isError, data, refetch } = useSystemApps()
  const apps = data ?? []

  return (
    <section aria-labelledby="platform-heading" className="mt-12">
      <details open>
        <summary
          id="platform-heading"
          className="mb-4 cursor-pointer text-sm font-medium text-muted-foreground"
        >
          Platform{apps.length > 0 ? ` · ${apps.length} services` : ""}
        </summary>

        {isPending && <p className="text-sm text-muted-foreground">Loading platform services…</p>}
        {isError && <ErrorBlock onRetry={refetch} />}
        {!isPending && !isError && apps.length > 0 && (
          <ul className="divide-y divide-foreground/10 rounded-xl bg-card ring-1 ring-foreground/10">
            {apps.map((app) => (
              <li key={app.name}>
                <Link
                  to={`/apps/${app.name}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/5"
                >
                  <AppIcon src={app.icon} name={app.displayName} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium leading-tight">{app.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">{app.version}</p>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground">
                    <Lock className="size-3" aria-hidden /> System
                  </span>
                  {app.installedStatus && app.installedStatus !== "not_installed" && (
                    <StatusBadge status={app.installedStatus} />
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm run test --workspace=packages/client -- src/components/PlatformPanel.test.tsx
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add ui/packages/client/src/hooks/useSystemApps.ts ui/packages/client/src/components/PlatformPanel.tsx ui/packages/client/src/components/PlatformPanel.test.tsx
git commit -m "feat(ui): add PlatformPanel + useSystemApps for read-only system apps"
```

---

### Task 7: Render `<PlatformPanel />` on the control-plane page

**Files:**
- Modify: `ui/packages/client/src/pages/MyAppsPage.tsx`

**Interfaces:**
- Consumes: `<PlatformPanel />` (Task 6).

- [ ] **Step 1: Add the import**

In `ui/packages/client/src/pages/MyAppsPage.tsx`, add to the imports:

```ts
import { PlatformPanel } from "@/components/PlatformPanel"
```

- [ ] **Step 2: Render the panel at the end of the page**

In the returned `<> … </>` fragment, add `<PlatformPanel />` as the last child (after the `hasApps && ( … )` block, before the closing `</>`). It manages its own loading/error/empty states, so it is always mounted:

```tsx
      {hasApps && (
        <>
          <DeviceSummary apps={apps} baseDomain={config?.baseDomain} />

          <section aria-labelledby="apps-heading" className="mt-8">
            <h2 id="apps-heading" className="mb-4 text-sm font-medium text-muted-foreground">
              Your apps
            </h2>
            <div style={GRID_STYLE}>
              {apps.map((app) => (
                <LaunchTile key={app.name} app={app} baseDomain={config?.baseDomain} />
              ))}
            </div>
          </section>

          <ControlsPanel />
        </>
      )}

      <PlatformPanel />
    </>
  )
}
```

- [ ] **Step 3: Verify the client builds and existing page tests pass**

```bash
npm run build:client
npm run test --workspace=packages/client -- src/pages/MyAppsPage.test.tsx
```
Expected: clean build; existing `MyAppsPage` tests still pass.

- [ ] **Step 4: Commit**

```bash
git add ui/packages/client/src/pages/MyAppsPage.tsx
git commit -m "feat(ui): show Platform panel on the control-plane home"
```

---

### Task 8: `AppDetailPage` read-only treatment for system apps

**Files:**
- Modify: `ui/packages/client/src/pages/AppDetailPage.tsx`
- Test: `ui/packages/client/src/pages/AppDetailPage.test.tsx`

**Interfaces:**
- Consumes: `CatalogApp.system` (Task 1).

- [ ] **Step 1: Write the failing test**

In `AppDetailPage.test.tsx`, add a test inside `describe('AppDetailPage', …)`:

```ts
  it('shows "Managed by platform" and hides Install/Open for a system app (SYS-01)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...mockApp, system: true, installedStatus: 'running' }),
    } as Response)
    render(<AppDetailPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText(/Managed by platform/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Install App' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Open Vaultwarden/i })).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test --workspace=packages/client -- src/pages/AppDetailPage.test.tsx
```
Expected: FAIL — "Managed by platform" not found (the running branch renders Open + Uninstall instead).

- [ ] **Step 3: Implement the system treatment**

In `ui/packages/client/src/pages/AppDetailPage.tsx`, add `Lock` to the lucide-react import:

```ts
import { Loader2, ExternalLink, Lock } from "lucide-react"
```

Replace the actions `<div className="mt-8 flex flex-wrap items-center gap-3"> … </div>` block with a branch on `data.system`:

```tsx
        <div className="mt-8 flex flex-wrap items-center gap-3">
          {data.system ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-foreground/5 px-3 py-1.5 text-sm text-muted-foreground">
              <Lock className="size-4" aria-hidden /> Managed by platform
            </span>
          ) : (
            <>
              {(!data.installedStatus || data.installedStatus === 'not_installed') && (
                <Button
                  onClick={() => installMutation.mutate()}
                  disabled={installMutation.isPending}
                >
                  {installMutation.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  {installMutation.isPending ? 'Installing...' : 'Install App'}
                </Button>
              )}

              {data.installedStatus === 'installing' && (
                <Button disabled>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Installing...
                </Button>
              )}

              {data.installedStatus === 'running' && (
                <>
                  {openUrl && (
                    <Button
                      render={<a href={openUrl} target="_blank" rel="noopener noreferrer" />}
                    >
                      Open {data.displayName}
                      <ExternalLink />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </Button>
                  )}
                  <UninstallAction
                    displayName={data.displayName}
                    uninstallMutation={uninstallMutation}
                  />
                </>
              )}

              {data.installedStatus === 'error' && (
                <UninstallAction
                  displayName={data.displayName}
                  uninstallMutation={uninstallMutation}
                />
              )}
            </>
          )}
        </div>
```

The status badge block above (`data.installedStatus && …`) already renders Running/Error for system apps, so no change is needed there.

- [ ] **Step 4: Run the full AppDetailPage spec**

```bash
npm run test --workspace=packages/client -- src/pages/AppDetailPage.test.tsx
```
Expected: PASS (all existing + the new system test).

- [ ] **Step 5: Commit**

```bash
git add ui/packages/client/src/pages/AppDetailPage.tsx ui/packages/client/src/pages/AppDetailPage.test.tsx
git commit -m "feat(ui): read-only Managed-by-platform treatment for system apps"
```

---

### Task 9: E2E Tier 1 — `SYSTEM_APPS_OVERRIDE` seam + platform spec

**Files:**
- Modify: `ui/packages/e2e/projects/tier1.config.ts`
- Create: `ui/packages/e2e/tests/app-level/platform.spec.ts`

**Interfaces:**
- Consumes: `SYSTEM_APPS_OVERRIDE` (Task 2), `/api/system-apps` + `/api/apps` filtering (Tasks 4–5). Uses the fixture catalog app `gogs` (present in `catalog.fixture.yaml`, category Development → user-facing) as the stand-in managed app.

- [ ] **Step 1: Wire the override into the Tier 1 server env**

In `ui/packages/e2e/projects/tier1.config.ts`, inside `webServer.env: { … }`, add:

```ts
      // Test seam: mark `gogs` as a managed platform app for this run, so the
      // Platform panel + /api/system-apps + the install 409 can be exercised
      // hermetically (no real system-apps Kustomization in Tier 1).
      SYSTEM_APPS_OVERRIDE: JSON.stringify([
        { name: 'gogs', kustomization: 'gogs' },
      ]),
```

- [ ] **Step 2: Write the spec**

Create `ui/packages/e2e/tests/app-level/platform.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

// `gogs` is marked managed via SYSTEM_APPS_OVERRIDE in tier1.config.ts.
const MANAGED = "gogs";

test.describe("Platform / system apps", () => {
  test("managed app is excluded from the Catalog API", async ({ request }) => {
    const res = await request.get("/api/apps");
    expect(res.ok()).toBeTruthy();
    const apps = await res.json();
    expect(apps.some((a: { name: string }) => a.name === MANAGED)).toBe(false);
  });

  test("managed app is exposed via /api/system-apps", async ({ request }) => {
    const res = await request.get("/api/system-apps");
    expect(res.ok()).toBeTruthy();
    const apps = await res.json();
    expect(apps.some((a: { name: string }) => a.name === MANAGED)).toBe(true);
  });

  test("installing a managed app is rejected (409)", async ({ request }) => {
    const res = await request.post(`/api/apps/${MANAGED}/install`);
    expect(res.status()).toBe(409);
  });

  test("Platform panel lists the managed app read-only on the home page", async ({ page }) => {
    await page.goto("/");
    // The Platform panel heading
    await expect(page.getByText(/Platform/)).toBeVisible();
    // The managed app row, with its System tag
    await expect(page.getByText("Gogs")).toBeVisible();
    await expect(page.getByText("System")).toBeVisible();
    // No install button on the home for it
    await expect(page.getByRole("button", { name: /install/i })).toHaveCount(0);
  });
});
```

- [ ] **Step 3: Run the Tier 1 e2e (this spec only)**

From `ui/`:
```bash
npm run test:e2e:ui -- tests/app-level/platform.spec.ts
```
Expected: PASS (4 tests). Builds client+server, brings up seeded Gogs, runs Playwright against `:3100`.

- [ ] **Step 4: Commit**

```bash
git add ui/packages/e2e/projects/tier1.config.ts ui/packages/e2e/tests/app-level/platform.spec.ts
git commit -m "test(ui): Tier 1 e2e for platform/system-apps via SYSTEM_APPS_OVERRIDE"
```

---

### Task 10: Document the system-apps concept in `ui/CLAUDE.md`

**Files:**
- Modify: `ui/CLAUDE.md`

- [ ] **Step 1: Document the new service, endpoint, and flag**

In `ui/CLAUDE.md`, in the **Architecture → Request flow** section, add a bullet:

```md
- `GET /api/system-apps` → `InstalledService.getSystemApps()` → enriched apps where `system === true` (the read-only Platform panel on `/`).
```

In the **Architecture** section, add a subsection after **Flux status (`FluxStatusService`)**:

```md
### System apps (`SystemAppsService`)
A "system app" is a platform component managed by the cluster's `system-apps`
Flux Kustomization (traefik, casdoor, gogs, frp-operator, …), not user-installable.
Membership is derived at runtime per cluster (flavour-correct): list flux-system
`OCIRepository`s carrying the `kustomize.toolkit.fluxcd.io/name=system-apps`
parent label, parse each `spec.url` (`oci://…/apps/<catalog-name>`) for the
catalog app name, and keep the paired Flux object name for status. Cached ~30s;
on k8s-unreachable degrades to the last-known set (empty on cold start).
`getSystemApps()` returns `Map<catalogName, fluxKustomizationName>` (note the
name can differ, e.g. `nfs-provisioner` → `storage`).

In `enrich`, system classification wins over the Gogs "installed?" check, and
status is derived via `FluxStatusService.getStatusFor(name, { systemKustomization })`
(queries the Kustomization by name, not the `marketplace.io/app` label). This is
why a system app like frp-operator reads `running` instead of a forever-`installing`
badge even when it also has a stale entry in the Gogs user-apps repo.

`CatalogApp.system` is a runtime-enriched boolean (not in `catalog.yaml`).
`/api/apps` excludes system apps; `/api/system-apps` lists them; install/uninstall
of a system app returns 409. The `SYSTEM_APPS_OVERRIDE` env (JSON
`[{name, kustomization}]`) is a test seam used by Tier 1 e2e.
```

- [ ] **Step 2: Commit**

```bash
git add ui/CLAUDE.md
git commit -m "docs(ui): document system-apps modeling and Platform panel"
```

---

## Self-Review (completed)

- **Spec coverage:** Detection (Task 2), status fix + precedence (Task 3), enrich precedence + 409 + getSystemApps (Task 4), `/api/system-apps` + `/api/apps` filter (Task 5), Platform panel (Tasks 6–7), detail-page treatment (Task 8), e2e contract (Task 9), docs (Task 10). All spec sections mapped.
- **Placeholder scan:** None — every step has real code or an exact command with expected output. The single verification item (Task 2 Step 1) has a documented fallback.
- **Type consistency:** `getSystemApps(): Promise<Map<string,string>>`, `isSystem(name): Promise<boolean>`, `getStatusFor(appName, opts?: { systemKustomization?: string })`, `getSystemApps()` (service) vs `getSystemApps()` (InstalledService returns `CatalogApp[]`) — distinct call sites, consistent within each. `CatalogApp.system` used identically on server and client.
