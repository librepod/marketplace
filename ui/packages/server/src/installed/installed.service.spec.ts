import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { InstalledService } from './installed.service';
import { GogsService } from './gogs.service';
import { FluxStatusService } from './flux-status.service';
import { CatalogService } from '../catalog/catalog.service';

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
  },
];

describe('InstalledService', () => {
  let service: InstalledService;
  let module: TestingModule;
  let mockGogsService: { getInstalledAppNames: ReturnType<typeof vi.fn> };
  let mockFluxService: { getStatusFor: ReturnType<typeof vi.fn> };
  let mockCatalogService: { findAll: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mockGogsService = { getInstalledAppNames: vi.fn() };
    mockFluxService = { getStatusFor: vi.fn() };
    mockCatalogService = { findAll: vi.fn().mockReturnValue(mockCatalogApps) };

    module = await Test.createTestingModule({
      providers: [
        InstalledService,
        { provide: GogsService, useValue: mockGogsService },
        { provide: FluxStatusService, useValue: mockFluxService },
        { provide: CatalogService, useValue: mockCatalogService },
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
});
