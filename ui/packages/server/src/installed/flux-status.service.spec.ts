import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { FluxStatusService } from './flux-status.service';

// Mock @kubernetes/client-node before importing FluxStatusService
// to avoid loadFromCluster() / loadFromDefault() errors in test env
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

describe('FluxStatusService', () => {
  let service: FluxStatusService;
  let module: TestingModule;

  function makeConditions(conditions: Array<{ type: string; status: string }>) {
    return {
      items: [{ status: { conditions } }],
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    module = await Test.createTestingModule({
      providers: [FluxStatusService],
    }).compile();

    service = module.get<FluxStatusService>(FluxStatusService);
    await module.init();
  });

  afterEach(async () => {
    await module.close();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getStatusFor(appName)', () => {
    it('returns "running" when Kustomization has Ready=True (BACK-03)', async () => {
      mockListNamespacedCustomObject.mockResolvedValueOnce(
        makeConditions([{ type: 'Ready', status: 'True' }]),
      );

      const status = await service.getStatusFor('vaultwarden');

      expect(status).toBe('running');
    });

    it('returns "installing" when Kustomization has Reconciling=True (BACK-03)', async () => {
      mockListNamespacedCustomObject.mockResolvedValueOnce(
        makeConditions([{ type: 'Reconciling', status: 'True' }]),
      );

      const status = await service.getStatusFor('vaultwarden');

      expect(status).toBe('installing');
    });

    it('returns "error" when Kustomization has Ready=False (BACK-03)', async () => {
      mockListNamespacedCustomObject.mockResolvedValueOnce(
        makeConditions([{ type: 'Ready', status: 'False' }]),
      );

      const status = await service.getStatusFor('vaultwarden');

      expect(status).toBe('error');
    });

    it('returns "installing" when Kustomization CRD not found, HelmRelease also not found (BACK-03)', async () => {
      // Both queries return empty items list (propagation lag)
      mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

      const status = await service.getStatusFor('vaultwarden');

      expect(status).toBe('installing');
    });

    it('falls back to HelmRelease when no Kustomization found, returns running (BACK-03)', async () => {
      // First call (Kustomization) returns empty
      mockListNamespacedCustomObject.mockResolvedValueOnce({ items: [] });
      // Second call (HelmRelease) returns Ready=True
      mockListNamespacedCustomObject.mockResolvedValueOnce(
        makeConditions([{ type: 'Ready', status: 'True' }]),
      );

      const status = await service.getStatusFor('open-webui');

      expect(status).toBe('running');
    });

    it('returns "installing" on k8s API error (graceful degradation) (BACK-03)', async () => {
      mockListNamespacedCustomObject.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const status = await service.getStatusFor('vaultwarden');

      expect(status).toBe('installing');
    });

    it('queries using label selector marketplace.io/app={appName} (BACK-03)', async () => {
      mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

      await service.getStatusFor('vaultwarden');

      expect(mockListNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          labelSelector: 'marketplace.io/app=vaultwarden',
        }),
      );
    });

    it('queries kustomize.toolkit.fluxcd.io/v1 Kustomizations first (BACK-03)', async () => {
      mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

      await service.getStatusFor('vaultwarden');

      const firstCall = mockListNamespacedCustomObject.mock.calls[0][0];
      expect(firstCall.group).toBe('kustomize.toolkit.fluxcd.io');
      expect(firstCall.version).toBe('v1');
      expect(firstCall.plural).toBe('kustomizations');
    });

    it('queries helm.toolkit.fluxcd.io/v2 HelmReleases as fallback (BACK-03)', async () => {
      mockListNamespacedCustomObject.mockResolvedValue({ items: [] });

      await service.getStatusFor('vaultwarden');

      const secondCall = mockListNamespacedCustomObject.mock.calls[1][0];
      expect(secondCall.group).toBe('helm.toolkit.fluxcd.io');
      expect(secondCall.version).toBe('v2');
      expect(secondCall.plural).toBe('helmreleases');
    });

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
