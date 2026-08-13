import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node';

const LAUNCH_URL_TTL_MS = 30_000;

export interface LaunchResolution {
  url?: string; // Axis A: resolved override URL, when a route opts in.
  launchable?: boolean; // Axis B: false ONLY on a confident "no IngressRoute" read.
}

interface IngressRouteObject {
  metadata?: { name?: string; annotations?: Record<string, string> };
  spec?: { routes?: Array<{ match?: string }> };
}

const LAUNCH_ANNOTATION = 'librepod.dev/launch';
const HOST_RE = /Host\(`([^`]+)`\)/;

@Injectable()
export class LaunchUrlService implements OnModuleInit {
  private readonly logger = new Logger(LaunchUrlService.name);
  private customObjectsApi!: CustomObjectsApi;
  private readonly cache = new Map<string, { value: LaunchResolution; expiresAt: number }>();

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
   * Resolve the launch tile behaviour for an app from its live IngressRoutes.
   * Never throws. `{}` means "no opinion — the client falls back to the
   * computed https://<name>.<baseDomain>".
   */
  async resolve(appName: string): Promise<LaunchResolution> {
    const cached = this.cache.get(appName);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
    const value = await this.computeResolution(appName);
    this.cache.set(appName, { value, expiresAt: Date.now() + LAUNCH_URL_TTL_MS });
    return value;
  }

  private async computeResolution(appName: string): Promise<LaunchResolution> {
    let items: IngressRouteObject[];
    try {
      const resp = (await this.customObjectsApi.listNamespacedCustomObject({
        group: 'traefik.io',
        version: 'v1alpha1',
        namespace: appName,
        plural: 'ingressroutes',
      })) as { items?: IngressRouteObject[] };
      items = resp.items ?? [];
    } catch (error: unknown) {
      // Uncertain — never suppress on an error. Fall back.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`k8s API unreachable for ${appName} IngressRoutes, falling back: ${message}`);
      return {};
    }

    // Axis B — decided BEFORE Axis A. A successful empty read = no web UI.
    if (items.length === 0) {
      return { launchable: false };
    }

    // Axis A — find the annotated route(s).
    const annotated = items
      .filter((r) => r.metadata?.annotations?.[LAUNCH_ANNOTATION] !== undefined)
      .sort((a, b) => (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''));

    if (annotated.length === 0) {
      // Has a UI at the default host — today's behaviour.
      return {};
    }
    if (annotated.length > 1) {
      this.logger.warn(
        `Multiple ${LAUNCH_ANNOTATION} routes for ${appName}; using name-sorted-first "${annotated[0].metadata?.name}"`,
      );
    }

    const route = annotated[0];
    const host = this.extractHost(route);
    if (!host) {
      return {};
    }
    const path = this.normalisePath(route.metadata!.annotations![LAUNCH_ANNOTATION]);
    return { url: `https://${host}${path}` };
  }

  private extractHost(route: IngressRouteObject): string | undefined {
    for (const r of route.spec?.routes ?? []) {
      const m = r.match?.match(HOST_RE);
      if (m) return m[1];
    }
    return undefined;
  }

  // Annotation value is a PATH. A bare "/" yields the host root (empty path).
  // A value missing its leading slash gets one. Never an absolute/external URL.
  private normalisePath(value: string): string {
    if (value === '/' || value === '') return '';
    return value.startsWith('/') ? value : `/${value}`;
  }
}
