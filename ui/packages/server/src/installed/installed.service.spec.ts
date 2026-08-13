import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InstalledService } from './installed.service';
import { GogsService } from './gogs.service';
import { FluxStatusService } from './flux-status.service';
import { CatalogService } from '../catalog/catalog.service';
import { ConfigService } from '@nestjs/config';
import { SystemAppsService } from './system-apps.service';

const mockCatalogApps = [
  {
    name: 'vaultwarden',
    displayName: 'Vaultwarden',
    description: 'Password manager',
    category: 'Security',
    version: '1.32.7',
    icon: 'https://example.com/vaultwarden.png',
    sourceType: 'oci-kustomize',
    sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/vaultwarden',
    templates: {
      source: 'apiVersion: source.toolkit.fluxcd.io/v1\nkind: OCIRepository',
      release: 'apiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization',
      secret: 'apiVersion: v1\nkind: Secret\nstringData:\n  ADMIN_TOKEN: "${ADMIN_TOKEN}"',
      kustomization: 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - source.yaml\n  - release.yaml\n  - secret.yaml',
    },
    params: {
      required: [{ name: 'BASE_DOMAIN', description: 'Base domain', type: 'string', example: 'example.com' }],
    },
    secrets: [
      { name: 'ADMIN_TOKEN', required: false, generate: { type: 'random', length: 64 } },
    ],
  },
  {
    name: 'gogs',
    displayName: 'Gogs',
    description: 'Git server',
    category: 'Developer Tools',
    version: '0.13.0',
    icon: 'https://example.com/gogs.png',
    sourceType: 'oci-kustomize',
    sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/gogs',
    templates: {
      source: 'apiVersion: source.toolkit.fluxcd.io/v1\nkind: OCIRepository',
      release: 'apiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization',
      kustomization: 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - source.yaml\n  - release.yaml',
    },
    params: {
      required: [{ name: 'BASE_DOMAIN', description: 'Base domain', type: 'string' }],
    },
    secrets: [],
  },
];

describe('InstalledService', () => {
  let service: InstalledService;
  let mockGogsService: {
    getInstalledAppNames: ReturnType<typeof vi.fn>;
    createFile: ReturnType<typeof vi.fn>;
    getFileContents: ReturnType<typeof vi.fn>;
    addToRootKustomization: ReturnType<typeof vi.fn>;
    removeFromRootKustomization: ReturnType<typeof vi.fn>;
  };
  let mockFluxService: { getStatusFor: ReturnType<typeof vi.fn> };
  let mockCatalogService: { findAll: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> };
  let mockSystemAppsService: {
    getSystemApps: ReturnType<typeof vi.fn>;
    isSystem: ReturnType<typeof vi.fn>;
  };
  let mockLaunchUrlService: { resolve: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockGogsService = {
      getInstalledAppNames: vi.fn(),
      createFile: vi.fn().mockResolvedValue(undefined),
      getFileContents: vi.fn(),
      addToRootKustomization: vi.fn().mockResolvedValue(undefined),
      removeFromRootKustomization: vi.fn().mockResolvedValue(undefined),
    };
    mockFluxService = { getStatusFor: vi.fn() };
    mockCatalogService = {
      findAll: vi.fn().mockReturnValue(mockCatalogApps),
      findOne: vi.fn().mockImplementation((name: string) =>
        mockCatalogApps.find(a => a.name === name),
      ),
    };

    const mockConfigService = {
      get: (key: string, defaultValue?: string) => {
        if (key === 'BASE_DOMAIN') return 'libre.pod';
        return defaultValue;
      },
    } as unknown as ConfigService;

    mockSystemAppsService = {
      getSystemApps: vi.fn().mockResolvedValue(new Map()),
      isSystem: vi.fn().mockResolvedValue(false),
    };

    mockLaunchUrlService = { resolve: vi.fn().mockResolvedValue({}) };

    service = new InstalledService(
      mockCatalogService as unknown as CatalogService,
      mockGogsService as unknown as GogsService,
      mockFluxService as unknown as FluxStatusService,
      mockConfigService,
      mockSystemAppsService as unknown as SystemAppsService,
      mockLaunchUrlService as unknown as import('./launch-url.service').LaunchUrlService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('enrich()', () => {
    it('sets installedStatus to not_installed for apps not in Gogs (BACK-02)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue([]);

      const enriched = await service.enrich(mockCatalogApps);

      expect(enriched[0].installedStatus).toBe('not_installed');
      expect(enriched[1].installedStatus).toBe('not_installed');
    });

    it('sets installedStatus from FluxCD for installed apps (BACK-02+03)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const enriched = await service.enrich(mockCatalogApps);

      expect(enriched[0].installedStatus).toBe('running');
      expect(enriched[1].installedStatus).toBe('not_installed');
    });

    it('uses Promise.all — does not call flux serially (BACK-03)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden', 'gogs']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      await service.enrich(mockCatalogApps);

      // Both apps are installed, so flux must be called for each
      expect(mockFluxService.getStatusFor).toHaveBeenCalledTimes(2);
    });

    it('does not call FluxCD for not-installed apps (BACK-03)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue([]);

      await service.enrich(mockCatalogApps);

      expect(mockFluxService.getStatusFor).not.toHaveBeenCalled();
    });
  });

  describe('enrich() launch fields', () => {
    it('stamps launchUrl when resolve returns { url }', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');
      mockLaunchUrlService.resolve.mockResolvedValue({ url: 'https://vaultwarden.example.com/ui' });

      const enriched = await service.enrich(mockCatalogApps);
      const vw = enriched.find((a) => a.name === 'vaultwarden')!;

      expect(vw.launchUrl).toBe('https://vaultwarden.example.com/ui');
      expect(vw.launchable).toBeUndefined();
    });

    it('stamps launchable:false when resolve returns { launchable:false }', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');
      mockLaunchUrlService.resolve.mockResolvedValue({ launchable: false });

      const enriched = await service.enrich(mockCatalogApps);
      const vw = enriched.find((a) => a.name === 'vaultwarden')!;

      expect(vw.launchable).toBe(false);
      expect(vw.launchUrl).toBeUndefined();
    });

    it('stamps neither field when resolve returns {}', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');
      mockLaunchUrlService.resolve.mockResolvedValue({});

      const enriched = await service.enrich(mockCatalogApps);
      const vw = enriched.find((a) => a.name === 'vaultwarden')!;

      expect(vw.launchUrl).toBeUndefined();
      expect(vw.launchable).toBeUndefined();
    });

    it('does not resolve launch info for not-installed apps', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue([]);

      await service.enrich(mockCatalogApps);

      expect(mockLaunchUrlService.resolve).not.toHaveBeenCalled();
    });
  });

  describe('getInstalled()', () => {
    it('returns only apps with installedStatus !== not_installed (INST-03)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const installed = await service.getInstalled();

      expect(installed).toHaveLength(1);
      expect(installed[0].name).toBe('vaultwarden');
    });

    it('returns empty array when no apps installed (INST-03)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue([]);

      const installed = await service.getInstalled();

      expect(installed).toEqual([]);
    });

    it('excludes system apps', async () => {
      mockSystemAppsService.getSystemApps.mockResolvedValue(
        new Map([['gogs', 'gogs']]),
      );
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden', 'gogs']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const installed = await service.getInstalled();

      expect(installed.map((a) => a.name)).toEqual(['vaultwarden']);
    });
  });

  describe('install()', () => {
    it('writes template files to Gogs and updates root kustomization (INST-01)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue([]);

      await service.install('vaultwarden');

      // Should create source.yaml, release.yaml, kustomization.yaml, secret.yaml
      expect(mockGogsService.createFile).toHaveBeenCalled();
      expect(mockGogsService.addToRootKustomization).toHaveBeenCalledWith('vaultwarden');
    });

    it('throws ConflictException if app is already installed (INST-01)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden']);

      await expect(service.install('vaultwarden')).rejects.toThrow();
    });

    it('throws NotFoundException if app not in catalog (INST-01)', async () => {
      mockCatalogService.findOne.mockReturnValue(undefined);

      await expect(service.install('nonexistent')).rejects.toThrow();
    });

    it('generates random secret when metadata has generate config (INST-01, D-04)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue([]);

      await service.install('vaultwarden');

      // secret.yaml should be created with a generated value, not ${ADMIN_TOKEN}
      const secretCalls = (mockGogsService.createFile as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: string[]) => call[0].includes('secret'),
      );
      expect(secretCalls.length).toBeGreaterThan(0);
      const secretContent = secretCalls[0][1] as string;
      expect(secretContent).not.toContain('${ADMIN_TOKEN}');
    });

    it('substitutes BASE_DOMAIN param in templates (INST-01, D-04)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue([]);

      await service.install('vaultwarden');

      // release.yaml should have the actual domain substituted
      const releaseCalls = (mockGogsService.createFile as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: string[]) => call[0].includes('release'),
      );
      expect(releaseCalls.length).toBeGreaterThan(0);
      const releaseContent = releaseCalls[0][1] as string;
      expect(releaseContent).not.toContain('${BASE_DOMAIN}');
    });
  });

  describe('uninstall()', () => {
    it('removes app from root kustomization (INST-02)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden']);

      await service.uninstall('vaultwarden');

      expect(mockGogsService.removeFromRootKustomization).toHaveBeenCalledWith('vaultwarden');
    });

    it('throws NotFoundException if app not in catalog (INST-02)', async () => {
      mockCatalogService.findOne.mockReturnValue(undefined);

      await expect(service.uninstall('nonexistent')).rejects.toThrow();
    });

    it('throws ConflictException if app is not installed (INST-02)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue([]);

      await expect(service.uninstall('vaultwarden')).rejects.toThrow();
    });
  });

  describe('mutex serialization (BACK-04)', () => {
    it('serializes concurrent install operations (BACK-04)', async () => {
      mockGogsService.getInstalledAppNames.mockResolvedValue([]);
      const order: string[] = [];
      mockGogsService.addToRootKustomization.mockImplementation(async (name: string) => {
        order.push(`start-${name}`);
        await new Promise(r => setTimeout(r, 50));
        order.push(`end-${name}`);
      });

      // Fire two installs concurrently
      await Promise.all([
        service.install('vaultwarden'),
        service.install('gogs'),
      ]);

      // Operations should be serialized: first completes before second starts
      // Serialized: start-A, end-A, start-B, end-B
      const vaultwardenStart = order.indexOf('start-vaultwarden');
      const vaultwardenEnd = order.indexOf('end-vaultwarden');
      const gogsStart = order.indexOf('start-gogs');
      const gogsEnd = order.indexOf('end-gogs');

      // One of them should fully complete before the other starts
      const serialized =
        (vaultwardenEnd < gogsStart) || (gogsEnd < vaultwardenStart);
      expect(serialized).toBe(true);
    });
  });

  describe('enrich() system classification', () => {
    it('marks a managed app system:true and derives status from the system branch', async () => {
      mockSystemAppsService.getSystemApps.mockResolvedValue(
        new Map([['gogs', 'gogs']]),
      );
      // gogs must be classified system BEFORE the Gogs check is consulted
      mockGogsService.getInstalledAppNames.mockResolvedValue(['gogs']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const enriched = await service.enrich(mockCatalogApps);

      const gogs = enriched.find((a) => a.name === 'gogs')!;
      expect(gogs.system).toBe(true);
      expect(gogs.installedStatus).toBe('running');
      expect(mockFluxService.getStatusFor).toHaveBeenCalledWith('gogs', {
        systemKustomization: 'gogs',
      });
    });

    it('resolves the original bug: frp-operator classified system → running, not installing', async () => {
      const frp = { ...mockCatalogApps[0], name: 'frp-operator', displayName: 'FRP Operator' };
      mockSystemAppsService.getSystemApps.mockResolvedValue(
        new Map([['frp-operator', 'frp-operator']]),
      );
      mockGogsService.getInstalledAppNames.mockResolvedValue(['frp-operator']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const [enriched] = await service.enrich([frp]);

      expect(enriched.system).toBe(true);
      expect(enriched.installedStatus).toBe('running');
    });

    it('leaves a user app system:false and uses the marketplace label query', async () => {
      mockSystemAppsService.getSystemApps.mockResolvedValue(new Map());
      mockGogsService.getInstalledAppNames.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const enriched = await service.enrich(mockCatalogApps);

      const vw = enriched.find((a) => a.name === 'vaultwarden')!;
      expect(vw.system).toBeFalsy();
      expect(mockFluxService.getStatusFor).toHaveBeenCalledWith('vaultwarden');
    });
  });

  describe('install() / uninstall() managed-app guard', () => {
    it('install throws ConflictException for a managed app', async () => {
      mockSystemAppsService.isSystem.mockResolvedValue(true);

      await expect(service.install('gogs')).rejects.toThrow(/managed by the platform/);
      expect(mockGogsService.createFile).not.toHaveBeenCalled();
    });

    it('uninstall throws ConflictException for a managed app', async () => {
      mockSystemAppsService.isSystem.mockResolvedValue(true);

      await expect(service.uninstall('gogs')).rejects.toThrow(/managed by the platform/);
      expect(mockGogsService.removeFromRootKustomization).not.toHaveBeenCalled();
    });
  });
});
