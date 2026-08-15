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

const LAUNCH_ANNOTATION = 'librepod.org/launch';
// Opt-out value: a route may exist for non-browser traffic (an API, a sync
// endpoint, a metrics scrape) yet serve no launchable web UI. Annotating that
// route "false" suppresses the tile — the one signal Axis B's zero-route rule
// cannot express while the route has to stay.
const LAUNCH_SUPPRESS_VALUE = 'false';
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

    // Axis B (explicit) — any route annotated "false" opts the whole app out of
    // launching, even if another route opts in with a path. An explicit "do not
    // launch" is a strong signal and wins over a path override.
    const suppressed = items.some(
      (r) => r.metadata?.annotations?.[LAUNCH_ANNOTATION] === LAUNCH_SUPPRESS_VALUE,
    );
    if (suppressed) {
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
  // A value missing its leading slash gets one. The contract is enforced, not
  // just documented: an absolute/external value ("https://…", "//host", a
  // "javascript:" scheme) is rejected and collapses to the host root, so a
  // stray annotation can never redirect the launch link off the app's own host.
  private normalisePath(value: string): string {
    if (value === '/' || value === '') return '';
    // Any scheme ("http://", "javascript:") or scheme-relative "//host" is not a path.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
      this.logger.warn(`Ignoring non-path ${LAUNCH_ANNOTATION} value "${value}"; using host root`);
      return '';
    }
    return value.startsWith('/') ? value : `/${value}`;
  }
}
