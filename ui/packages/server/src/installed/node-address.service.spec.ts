import { describe, it, expect, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CoreV1Api } from '@kubernetes/client-node';
import { NodeAddressService } from './node-address.service';

function make(readNode: ReturnType<typeof vi.fn>, env: Record<string, string> = { NODE_NAME: 'node-1' }) {
  return new NodeAddressService({ readNode } as unknown as CoreV1Api, new ConfigService(env));
}

describe('NodeAddressService.internalIp', () => {
  it("returns the node's InternalIP — not its hostname or external address", async () => {
    const readNode = vi.fn().mockResolvedValue({
      status: {
        addresses: [
          { type: 'Hostname', address: 'node-1' },
          { type: 'ExternalIP', address: '203.0.113.7' },
          { type: 'InternalIP', address: '192.168.1.50' },
        ],
      },
    });
    expect(await make(readNode).internalIp()).toBe('192.168.1.50');
    expect(readNode).toHaveBeenCalledWith({ name: 'node-1' });
  });

  it('prefers an IPv4 InternalIP on a dual-stack node', async () => {
    const readNode = vi.fn().mockResolvedValue({
      status: { addresses: [{ type: 'InternalIP', address: 'fd00::5' }, { type: 'InternalIP', address: '192.168.1.50' }] },
    });
    expect(await make(readNode).internalIp()).toBe('192.168.1.50');
  });

  it('503s when NODE_NAME is unset, the read fails, or no InternalIP is reported', async () => {
    const noIp = vi.fn().mockResolvedValue({ status: { addresses: [{ type: 'Hostname', address: 'node-1' }] } });
    await expect(make(vi.fn(), {}).internalIp()).rejects.toThrow(ServiceUnavailableException);
    await expect(make(vi.fn().mockRejectedValue(new Error('forbidden'))).internalIp()).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(make(noIp).internalIp()).rejects.toThrow(ServiceUnavailableException);
  });
});
