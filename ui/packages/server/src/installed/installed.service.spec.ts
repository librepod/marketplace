import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InstalledService } from './installed.service';
import { UserAppsRepoService } from './user-apps-repo.service';
import { FluxStatusService } from './flux-status.service';
import { CatalogService } from '../catalog/catalog.service';
import { ConfigService } from '@nestjs/config';
import { SystemAppsService } from './system-apps.service';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OpenBaoClient, OpenBaoMisconfiguredError, OpenBaoUnavailableError } from './openbao.client';

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

// An app with install questions (catalog `settings`) — exercised by the OpenBao path.
const settingsApp = {
  name: 'renovate',
  displayName: 'Renovate',
  description: 'Dependency updates',
  category: 'Automation',
  version: '41.0.0',
  icon: 'https://example.com/renovate.png',
  sourceType: 'oci-kustomize',
  sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/renovate',
  templates: {
    source: 'apiVersion: source.toolkit.fluxcd.io/v1\nkind: OCIRepository',
    release: 'apiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization\nhost: renovate.${BASE_DOMAIN}',
    kustomization: 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - source.yaml\n  - release.yaml',
  },
  settings: {
    allowCustom: true,
    items: [
      { name: 'RENOVATE_TOKEN', sensitive: true, required: true },
      { name: 'LOG_FORMAT', default: 'json' },
    ],
  },
};

describe('InstalledService', () => {
  let service: InstalledService;
  // Exactly the three methods InstalledService calls on the app-store repo.
  // Install is now ONE write (a single commit), not four ordered file PUTs.
  let mockRepo: {
    listInstalledApps: ReturnType<typeof vi.fn>;
    writeApp: ReturnType<typeof vi.fn>;
    removeApp: ReturnType<typeof vi.fn>;
  };
  let mockFluxService: { getStatusFor: ReturnType<typeof vi.fn> };
  let mockCatalogService: { findAll: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> };
  let mockSystemAppsService: {
    getSystemApps: ReturnType<typeof vi.fn>;
    isSystem: ReturnType<typeof vi.fn>;
  };
  let mockLaunchUrlService: { resolve: ReturnType<typeof vi.fn> };
  let mockOpenBao: { writeAppSettings: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockRepo = {
      listInstalledApps: vi.fn(async () => [] as string[]),
      writeApp: vi.fn(async () => undefined),
      removeApp: vi.fn(async () => undefined),
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

    mockOpenBao = { writeAppSettings: vi.fn(async () => undefined) };

    service = new InstalledService(
      mockCatalogService as unknown as CatalogService,
      mockRepo as unknown as UserAppsRepoService,
      mockFluxService as unknown as FluxStatusService,
      mockConfigService,
      mockSystemAppsService as unknown as SystemAppsService,
      mockLaunchUrlService as unknown as import('./launch-url.service').LaunchUrlService,
      mockOpenBao as unknown as OpenBaoClient,
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
      mockRepo.listInstalledApps.mockResolvedValue([]);

      const enriched = await service.enrich(mockCatalogApps);

      expect(enriched[0].installedStatus).toBe('not_installed');
      expect(enriched[1].installedStatus).toBe('not_installed');
    });

    it('sets installedStatus from FluxCD for installed apps (BACK-02+03)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const enriched = await service.enrich(mockCatalogApps);

      expect(enriched[0].installedStatus).toBe('running');
      expect(enriched[1].installedStatus).toBe('not_installed');
    });

    it('uses Promise.all — does not call flux serially (BACK-03)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden', 'gogs']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      await service.enrich(mockCatalogApps);

      // Both apps are installed, so flux must be called for each
      expect(mockFluxService.getStatusFor).toHaveBeenCalledTimes(2);
    });

    it('does not call FluxCD for not-installed apps (BACK-03)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue([]);

      await service.enrich(mockCatalogApps);

      expect(mockFluxService.getStatusFor).not.toHaveBeenCalled();
    });
  });

  describe('enrich() launch fields', () => {
    it('stamps launchUrl when resolve returns { url }', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');
      mockLaunchUrlService.resolve.mockResolvedValue({ url: 'https://vaultwarden.example.com/ui' });

      const enriched = await service.enrich(mockCatalogApps);
      const vw = enriched.find((a) => a.name === 'vaultwarden')!;

      expect(vw.launchUrl).toBe('https://vaultwarden.example.com/ui');
      expect(vw.launchable).toBeUndefined();
    });

    it('stamps launchable:false when resolve returns { launchable:false }', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');
      mockLaunchUrlService.resolve.mockResolvedValue({ launchable: false });

      const enriched = await service.enrich(mockCatalogApps);
      const vw = enriched.find((a) => a.name === 'vaultwarden')!;

      expect(vw.launchable).toBe(false);
      expect(vw.launchUrl).toBeUndefined();
    });

    it('stamps neither field when resolve returns {}', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');
      mockLaunchUrlService.resolve.mockResolvedValue({});

      const enriched = await service.enrich(mockCatalogApps);
      const vw = enriched.find((a) => a.name === 'vaultwarden')!;

      expect(vw.launchUrl).toBeUndefined();
      expect(vw.launchable).toBeUndefined();
    });

    it('does not resolve launch info for not-installed apps', async () => {
      mockRepo.listInstalledApps.mockResolvedValue([]);

      await service.enrich(mockCatalogApps);

      expect(mockLaunchUrlService.resolve).not.toHaveBeenCalled();
    });

    it('stamps launch fields on a system app too (system branch calls withLaunch)', async () => {
      mockSystemAppsService.getSystemApps.mockResolvedValue(
        new Map([['gogs', 'gogs']]),
      );
      // Not in Gogs — status must come from the system branch, which still
      // resolves launch info (a managed app can carry a launch override).
      mockRepo.listInstalledApps.mockResolvedValue([]);
      mockFluxService.getStatusFor.mockResolvedValue('running');
      mockLaunchUrlService.resolve.mockResolvedValue({ url: 'https://gogs.example.com' });

      const enriched = await service.enrich(mockCatalogApps);
      const gogs = enriched.find((a) => a.name === 'gogs')!;

      expect(gogs.system).toBe(true);
      expect(mockLaunchUrlService.resolve).toHaveBeenCalledWith('gogs');
      expect(gogs.launchUrl).toBe('https://gogs.example.com');
    });
  });

  describe('getInstalled()', () => {
    it('returns only apps with installedStatus !== not_installed (INST-03)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const installed = await service.getInstalled();

      expect(installed).toHaveLength(1);
      expect(installed[0].name).toBe('vaultwarden');
    });

    it('returns empty array when no apps installed (INST-03)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue([]);

      const installed = await service.getInstalled();

      expect(installed).toEqual([]);
    });

    it('excludes system apps', async () => {
      mockSystemAppsService.getSystemApps.mockResolvedValue(
        new Map([['gogs', 'gogs']]),
      );
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden', 'gogs']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const installed = await service.getInstalled();

      expect(installed.map((a) => a.name)).toEqual(['vaultwarden']);
    });
  });

  describe('install()', () => {
    it('writes every rendered app file in a single repo write (INST-01)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue([]);

      await service.install('vaultwarden');

      expect(mockRepo.writeApp).toHaveBeenCalledTimes(1);
      const [name, files] = mockRepo.writeApp.mock.calls[0];
      expect(name).toBe('vaultwarden');
      expect(Object.keys(files).sort()).toEqual([
        'kustomization.yaml', 'release.yaml', 'secret.yaml', 'source.yaml',
      ]);
      expect(files['secret.yaml']).not.toContain('${ADMIN_TOKEN}'); // generated
    });

    it('throws ConflictException if app is already installed (INST-01)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);

      await expect(service.install('vaultwarden')).rejects.toThrow();
    });

    it('throws NotFoundException if app not in catalog (INST-01)', async () => {
      mockCatalogService.findOne.mockReturnValue(undefined);

      await expect(service.install('nonexistent')).rejects.toThrow();
    });

    it('generates random secret when metadata has generate config (INST-01, D-04)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue([]);

      await service.install('vaultwarden');

      const [, files] = mockRepo.writeApp.mock.calls[0];
      expect(files['secret.yaml']).toBeDefined();
      expect(files['secret.yaml']).not.toContain('${ADMIN_TOKEN}');
    });

    it('substitutes BASE_DOMAIN param in templates (INST-01, D-04)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue([]);

      await service.install('vaultwarden');

      const [, files] = mockRepo.writeApp.mock.calls[0];
      expect(files['release.yaml']).not.toContain('${BASE_DOMAIN}');
    });
  });

  describe('install() with settings', () => {
    beforeEach(() => {
      mockCatalogService.findOne.mockReturnValue(settingsApp);
      mockRepo.listInstalledApps.mockResolvedValue([]);
    });

    it('writes the resolved settings to OpenBao before committing to Gogs', async () => {
      const calls: string[] = [];
      mockOpenBao.writeAppSettings.mockImplementation(async () => {
        calls.push('openbao');
      });
      mockRepo.writeApp.mockImplementation(async () => {
        calls.push('gogs');
      });

      await service.install('renovate', {
        settings: { RENOVATE_TOKEN: 's3cr3t' },
        custom: [{ name: 'HTTP_PROXY', value: 'http://p:3128' }],
      });

      expect(mockOpenBao.writeAppSettings).toHaveBeenCalledWith('renovate', {
        RENOVATE_TOKEN: 's3cr3t',
        LOG_FORMAT: 'json',
        HTTP_PROXY: 'http://p:3128',
      });
      expect(calls).toEqual(['openbao', 'gogs']);
    });

    it('never puts setting values into the Gogs files', async () => {
      await service.install('renovate', { settings: { RENOVATE_TOKEN: 's3cr3t' } });

      const [, files] = mockRepo.writeApp.mock.calls[0];
      expect(Object.keys(files).sort()).toEqual(['kustomization.yaml', 'release.yaml', 'source.yaml']);
      expect(Object.values(files).join('\n')).not.toContain('s3cr3t');
      expect(files['release.yaml']).toContain('renovate.libre.pod'); // BASE_DOMAIN still substituted
    });

    it('rejects invalid settings with 400 field errors and writes nothing', async () => {
      const err = await service.install('renovate', {}).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        message: 'Some settings need attention',
        errors: [{ name: 'RENOVATE_TOKEN', message: 'Required' }],
      });
      expect(mockOpenBao.writeAppSettings).not.toHaveBeenCalled();
      expect(mockRepo.writeApp).not.toHaveBeenCalled();
    });

    it('treats a missing body (no JSON sent) as all defaults', async () => {
      mockCatalogService.findOne.mockReturnValue({
        ...settingsApp,
        settings: { items: [{ name: 'LOG_FORMAT', default: 'json' }] },
      });

      await service.install('renovate', undefined);

      expect(mockOpenBao.writeAppSettings).toHaveBeenCalledWith('renovate', { LOG_FORMAT: 'json' });
    });

    it('writes an empty entry when every question is optional and unanswered', async () => {
      mockCatalogService.findOne.mockReturnValue({
        ...settingsApp,
        settings: { items: [{ name: 'OPTIONAL_THING' }] },
      });

      await service.install('renovate', {});

      expect(mockOpenBao.writeAppSettings).toHaveBeenCalledWith('renovate', {});
    });

    it('returns 503 and commits nothing when OpenBao is unavailable', async () => {
      mockOpenBao.writeAppSettings.mockRejectedValue(
        new OpenBaoUnavailableError('write apps/renovate failed: HTTP 503'),
      );

      await expect(
        service.install('renovate', { settings: { RENOVATE_TOKEN: 's3cr3t' } }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockRepo.writeApp).not.toHaveBeenCalled();
    });

    it('returns 500 without "try again" and commits nothing when OpenBao is misconfigured', async () => {
      mockOpenBao.writeAppSettings.mockRejectedValue(
        new OpenBaoMisconfiguredError('write apps/renovate failed: HTTP 403'),
      );

      const err = await service
        .install('renovate', { settings: { RENOVATE_TOKEN: 's3cr3t' } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect((err as Error).message).not.toMatch(/try again in a minute/i);
      expect(mockRepo.writeApp).not.toHaveBeenCalled();
    });

    it('lets unexpected errors through unchanged', async () => {
      mockOpenBao.writeAppSettings.mockRejectedValue(new TypeError('boom'));

      await expect(
        service.install('renovate', { settings: { RENOVATE_TOKEN: 's3cr3t' } }),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('checks "already installed" before validating settings (409, not 400)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['renovate']);

      await expect(service.install('renovate', {})).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('apps without settings never touch OpenBao, even when a body is sent', async () => {
    mockRepo.listInstalledApps.mockResolvedValue([]);

    await service.install('vaultwarden', { settings: { ANYTHING: 'x' } });

    expect(mockOpenBao.writeAppSettings).not.toHaveBeenCalled();
    expect(mockRepo.writeApp).toHaveBeenCalledTimes(1);
  });

  describe('uninstall()', () => {
    it('uninstall removes the app directory (INST-02)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);

      await service.uninstall('vaultwarden');

      expect(mockRepo.removeApp).toHaveBeenCalledWith('vaultwarden');
    });

    it('throws NotFoundException if app not in catalog (INST-02)', async () => {
      mockCatalogService.findOne.mockReturnValue(undefined);

      await expect(service.uninstall('nonexistent')).rejects.toThrow();
    });

    it('throws ConflictException if app is not installed (INST-02)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue([]);

      await expect(service.uninstall('vaultwarden')).rejects.toThrow();
    });
  });

  describe('mutex serialization (BACK-04)', () => {
    it('serializes concurrent install operations (BACK-04)', async () => {
      mockRepo.listInstalledApps.mockResolvedValue([]);
      const order: string[] = [];
      mockRepo.writeApp.mockImplementation(async (name: string) => {
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
      mockRepo.listInstalledApps.mockResolvedValue(['gogs']);
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
      mockRepo.listInstalledApps.mockResolvedValue(['frp-operator']);
      mockFluxService.getStatusFor.mockResolvedValue('running');

      const [enriched] = await service.enrich([frp]);

      expect(enriched.system).toBe(true);
      expect(enriched.installedStatus).toBe('running');
    });

    it('leaves a user app system:false and uses the marketplace label query', async () => {
      mockSystemAppsService.getSystemApps.mockResolvedValue(new Map());
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);
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
      expect(mockRepo.writeApp).not.toHaveBeenCalled();
    });

    it('uninstall throws ConflictException for a managed app', async () => {
      mockSystemAppsService.isSystem.mockResolvedValue(true);

      await expect(service.uninstall('gogs')).rejects.toThrow(/managed by the platform/);
      expect(mockRepo.removeApp).not.toHaveBeenCalled();
    });
  });
});
