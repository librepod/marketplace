import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CoreV1Api } from '@kubernetes/client-node';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The device's LAN address: the InternalIP (an IPv4 one when the node is
 * dual-stack, else the first) of the node this pod runs on,
 * rendered into app templates as ${DEVICE_IP} (e.g. the WireGuard endpoint
 * host clients dial). NODE_NAME comes from the downward API
 * (apps/marketplace-ui/base/deployment.yaml); reading the Node needs `get
 * nodes` in the ClusterRole (base/serviceaccount.yaml). Read per install,
 * never cached, so an address change between installs is never served stale.
 */
@Injectable()
export class NodeAddressService {
  private readonly logger = new Logger(NodeAddressService.name);

  constructor(
    private readonly core: CoreV1Api,
    private readonly config: ConfigService,
  ) {}

  async internalIp(): Promise<string> {
    const name = this.config.get<string>('NODE_NAME');
    try {
      if (!name) throw new Error('NODE_NAME is not set');
      const node = await this.core.readNode({ name });
      const internal = (node.status?.addresses ?? []).filter((a) => a.type === 'InternalIP');
      const ip = (internal.find((a) => IPV4.test(a.address)) ?? internal[0])?.address;
      if (!ip) throw new Error(`node ${name} reports no InternalIP`);
      return ip;
    } catch (err) {
      this.logger.warn(`device address lookup failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException("Couldn't determine this device's address. Try again in a minute.");
    }
  }
}
