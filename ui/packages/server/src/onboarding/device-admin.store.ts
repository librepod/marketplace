import { Injectable, Logger } from '@nestjs/common';
import { CoreV1Api, KubeConfig, V1Secret } from '@kubernetes/client-node';

const SECRET_NAME = 'marketplace-ui-admin-credential';
const NAMESPACE = 'marketplace-ui';

/**
 * Persists the device-admin password (the one credential the owner chose at
 * claim) to a Secret in our own namespace — same model as
 * marketplace-ui-session: not in Git, so Flux never prunes it; written at
 * runtime by the server, readable across pod restarts so lazy retries, a
 * future Users-panel re-sync, and install-time app provisioning all inherit
 * it. `wgHost` records the WireGuard endpoint host the wizard configured
 * (the device IP at claim time) so the lazy wg-easy adoption can complete
 * first-boot setup even after a claim-time wg-easy outage. RBAC: Role in
 * apps/marketplace-ui/base/serviceaccount.yaml.
 */
@Injectable()
export class DeviceAdminStore {
  private readonly logger = new Logger(DeviceAdminStore.name);
  private core?: CoreV1Api;

  private client(): CoreV1Api | undefined {
    if (this.core) return this.core;
    try {
      const kc = new KubeConfig();
      kc.loadFromDefault(); // in-cluster when KUBERNETES_SERVICE_HOST is set, kubeconfig otherwise
      this.core = kc.makeApiClient(CoreV1Api);
      return this.core;
    } catch (err) {
      this.logger.debug(`k8s config unavailable: ${String(err)}`);
      return undefined;
    }
  }

  async load(): Promise<{ password?: string; wgHost?: string }> {
    const core = this.client();
    if (!core) return {};
    try {
      const secret: V1Secret = await core.readNamespacedSecret({
        name: SECRET_NAME,
        namespace: NAMESPACE,
      });
      const decode = (key: string) =>
        secret.data?.[key] ? Buffer.from(secret.data[key], 'base64').toString('utf8') : undefined;
      return { password: decode('password'), wgHost: decode('wgHost') };
    } catch {
      return {}; // absent or RBAC-denied — both mean "not provisioned yet"
    }
  }

  async save(password: string, wgHost?: string): Promise<void> {
    const core = this.client();
    if (!core) throw new Error('k8s config unavailable');
    const secret: V1Secret = {
      metadata: {
        name: SECRET_NAME,
        namespace: NAMESPACE,
        labels: { 'app.kubernetes.io/name': 'marketplace-ui' },
      },
      stringData: wgHost ? { password, wgHost } : { password },
    };
    try {
      await core.replaceNamespacedSecret({ name: SECRET_NAME, namespace: NAMESPACE, body: secret });
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode === 404) {
        await core.createNamespacedSecret({ namespace: NAMESPACE, body: secret });
      } else {
        throw err;
      }
    }
  }
}
