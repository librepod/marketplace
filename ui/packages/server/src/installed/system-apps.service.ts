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
