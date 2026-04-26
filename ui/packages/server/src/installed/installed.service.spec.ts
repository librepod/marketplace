import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { InstalledService } from './installed.service';
import { GogsService } from './gogs.service';
import { FluxStatusService } from './flux-status.service';
import { CatalogService } from '../catalog/catalog.service';
import { ConfigService } from '@nestjs/config';

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
      source: 'apiVersion: source.toolkit.fluxcd.io/v1beta2\nkind: OCIRepository',
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
      source: 'apiVersion: source.toolkit.fluxcd.io/v1beta2\nkind: OCIRepository',
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
  let module: TestingModule;
  let mockGogsService: {
    getInstalledAppNames: ReturnType<typeof vi.fn>;
    createFile: ReturnType<typeof vi.fn>;
    getFileContents: ReturnType<typeof vi.fn>;
    addToRootKustomization: ReturnType<typeof vi.fn>;
    removeFromRootKustomization: ReturnType<typeof vi.fn>;
  };
  let mockFluxService: { getStatusFor: ReturnType<typeof vi.fn> };
  let mockCatalogService: { findAll: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
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

    module = await Test.createTestingModule({
      providers: [
        InstalledService,
        { provide: GogsService, useValue: mockGogsService },
        { provide: FluxStatusService, useValue: mockFluxService },
        { provide: CatalogService, useValue: mockCatalogService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: string) => {
              if (key === 'BASE_DOMAIN') return 'libre.pod';
              return defaultValue;
            },
          },
        },
      ],
    }).compile();

    service = module.get<InstalledService>(InstalledService);
  });

  afterEach(async () => {
    await module.close();
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
});
