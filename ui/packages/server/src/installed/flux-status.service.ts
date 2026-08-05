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
        return this.deriveStatusFromConditions(
          kustItems[0].status?.conditions ?? [],
        );
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
        return this.deriveStatusFromConditions(
          helmItems[0].status?.conditions ?? [],
        );
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
