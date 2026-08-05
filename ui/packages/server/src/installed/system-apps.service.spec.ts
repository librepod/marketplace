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
