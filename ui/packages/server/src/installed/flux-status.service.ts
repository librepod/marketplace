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

  async getStatusFor(appName: string): Promise<AppStatus> {
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
      this.logger.warn(
        `k8s API unreachable for ${appName}, returning installing: ${message}`,
      );
      return 'installing';
    }
  }

  private deriveStatusFromConditions(conditions: FluxCondition[]): AppStatus {
    const ready = conditions.find((c) => c.type === 'Ready');
    const reconciling = conditions.find((c) => c.type === 'Reconciling');
    if (ready?.status === 'True') return 'running';
    if (reconciling?.status === 'True') return 'installing';
    if (ready?.status === 'False') return 'error';
    return 'installing';
  }
}
