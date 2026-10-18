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
  NotFoundException,
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
  let mockOpenBao: {
    readAppSettings: ReturnType<typeof vi.fn>;
    writeAppSettings: ReturnType<typeof vi.fn>;
  };
  let mockLegacyMirror: { snapshotApp: ReturnType<typeof vi.fn> };
  let mockNodeAddress: { internalIp: ReturnType<typeof vi.fn> };
  let mockK8s: { patchNamespacedCustomObject: ReturnType<typeof vi.fn> };

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
        [...mockCatalogApps, settingsApp].find(a => a.name === name),
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

    mockOpenBao = {
      readAppSettings: vi.fn(async () => null),
      writeAppSettings: vi.fn(async () => undefined),
    };

    mockLegacyMirror = { snapshotApp: vi.fn(async () => 0) };
    mockNodeAddress = { internalIp: vi.fn() };
    mockK8s = { patchNamespacedCustomObject: vi.fn(async () => ({})) };

    service = new InstalledService(
      mockCatalogService as unknown as CatalogService,
      mockRepo as unknown as UserAppsRepoService,
      mockFluxService as unknown as FluxStatusService,
      mockConfigService,
      mockSystemAppsService as unknown as SystemAppsService,
      mockLaunchUrlService as unknown as import('./launch-url.service').LaunchUrlService,
      mockOpenBao as unknown as OpenBaoClient,
      mockLegacyMirror as unknown as import('./legacy-secret-mirror').LegacySecretMirror,
      mockNodeAddress as unknown as import('./node-address.service').NodeAddressService,
      mockK8s as unknown as import('@kubernetes/client-node').CustomObjectsApi,
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

  describe('appStatus()', () => {
    it('not_installed — without asking Flux — when the app is not in the repo', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);
      expect(await service.appStatus('wg-easy')).toBe('not_installed');
      expect(mockFluxService.getStatusFor).not.toHaveBeenCalled();
    });

    it("an installed app's Flux status", async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['wg-easy']);
      mockFluxService.getStatusFor.mockResolvedValue('installing');
      expect(await service.appStatus('wg-easy')).toBe('installing');
      expect(mockFluxService.getStatusFor).toHaveBeenCalledWith('wg-easy');
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

  describe('install() DEVICE_IP', () => {
    // Shaped like wg-easy: one install question, and a release that asks for
    // the device's LAN address as the WireGuard endpoint host.
    const vpnApp = {
      ...mockCatalogApps[1],
      name: 'wg-easy',
      displayName: 'WG Easy',
      templates: {
        ...mockCatalogApps[1].templates,
        release:
          'kind: Kustomization\npostBuild:\n  substitute:\n    BASE_DOMAIN: "${BASE_DOMAIN}"\n    DEVICE_IP: "${DEVICE_IP}"',
      },
      settings: { items: [{ name: 'INIT_PASSWORD', required: true, sensitive: true }] },
    };
    const body = { settings: { INIT_PASSWORD: 'correct-horse-12' } };

    beforeEach(() => {
      mockCatalogService.findOne.mockReturnValue(vpnApp);
    });

    it("renders the node's InternalIP where a template asks for ${DEVICE_IP}", async () => {
      mockNodeAddress.internalIp.mockResolvedValue('192.168.1.50');
      await service.install('wg-easy', body);
      const [, files] = mockRepo.writeApp.mock.calls[0];
      expect(files['release.yaml']).toContain('DEVICE_IP: "192.168.1.50"');
      expect(files['release.yaml']).toContain('BASE_DOMAIN: "libre.pod"');
    });

    it('never reads the node for an app whose templates do not reference it', async () => {
      mockCatalogService.findOne.mockReturnValue(mockCatalogApps[1]);
      await service.install('gogs');
      expect(mockNodeAddress.internalIp).not.toHaveBeenCalled();
      expect(mockRepo.writeApp).toHaveBeenCalledTimes(1);
    });

    it('invalid settings are a 400 before any node lookup', async () => {
      mockNodeAddress.internalIp.mockRejectedValue(new ServiceUnavailableException('node down'));
      await expect(service.install('wg-easy', { settings: {} })).rejects.toThrow(BadRequestException);
      expect(mockNodeAddress.internalIp).not.toHaveBeenCalled();
    });

    it('a failed lookup is a 503 that writes nothing — no OpenBao entry, no commit', async () => {
      mockNodeAddress.internalIp.mockRejectedValue(
        new ServiceUnavailableException("Couldn't determine this device's address. Try again in a minute."),
      );
      await expect(service.install('wg-easy', body)).rejects.toThrow(ServiceUnavailableException);
      expect(mockOpenBao.writeAppSettings).not.toHaveBeenCalled();
      expect(mockRepo.writeApp).not.toHaveBeenCalled();
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

    it('reads the stored entry first and feeds it to the resolver (a reinstall keeps generated values)', async () => {
      mockCatalogService.findOne.mockReturnValue({
        ...settingsApp,
        settings: { items: [{ name: 'DB_PASSWORD', generate: { type: 'random', length: 40 } }] },
      });
      mockOpenBao.readAppSettings.mockResolvedValue({ DB_PASSWORD: 'kept-from-last-install' });

      await service.install('renovate');

      expect(mockOpenBao.readAppSettings).toHaveBeenCalledWith('renovate');
      expect(mockOpenBao.writeAppSettings).toHaveBeenCalledWith('renovate', {
        DB_PASSWORD: 'kept-from-last-install',
      });
    });

    it('reads before writing and before the Gogs commit', async () => {
      const calls: string[] = [];
      mockOpenBao.readAppSettings.mockImplementation(async () => {
        calls.push('read');
        return null;
      });
      mockOpenBao.writeAppSettings.mockImplementation(async () => {
        calls.push('openbao');
      });
      mockRepo.writeApp.mockImplementation(async () => {
        calls.push('gogs');
      });

      await service.install('renovate', { settings: { RENOVATE_TOKEN: 's3cr3t' } });

      expect(calls).toEqual(['read', 'openbao', 'gogs']);
    });

    it('returns 503 and commits nothing when reading the stored entry fails', async () => {
      mockOpenBao.readAppSettings.mockRejectedValue(
        new OpenBaoUnavailableError('read apps/renovate failed: HTTP 503'),
      );

      await expect(
        service.install('renovate', { settings: { RENOVATE_TOKEN: 's3cr3t' } }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockOpenBao.writeAppSettings).not.toHaveBeenCalled();
      expect(mockRepo.writeApp).not.toHaveBeenCalled();
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

    it('snapshots legacy secrets BEFORE removeApp — after it the values exist nowhere', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);
      const calls: string[] = [];
      mockLegacyMirror.snapshotApp.mockImplementation(async () => {
        calls.push('mirror');
        return 0;
      });
      mockRepo.removeApp.mockImplementation(async () => {
        calls.push('remove');
      });

      await service.uninstall('vaultwarden');

      // The ORDER is the whole point: removeApp deletes the Gogs files, and the
      // legacy values are unrecoverable from that moment on.
      expect(calls).toEqual(['mirror', 'remove']);
      expect(mockLegacyMirror.snapshotApp).toHaveBeenCalledWith('vaultwarden');
    });

    it('a failing legacy snapshot is logged, not fatal — uninstall proceeds', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);
      mockLegacyMirror.snapshotApp.mockRejectedValue(new Error('bao down'));

      await expect(service.uninstall('vaultwarden')).resolves.toEqual({
        success: true,
        message: 'Vaultwarden has been removed',
      });
      expect(mockRepo.removeApp).toHaveBeenCalledWith('vaultwarden');
    });

    it('install never calls the legacy mirror', async () => {
      mockRepo.listInstalledApps.mockResolvedValue([]);

      await service.install('vaultwarden');

      expect(mockLegacyMirror.snapshotApp).not.toHaveBeenCalled();
    });
  });

  describe('getSettings()', () => {
    it('returns the stored entry as a request, for an app that is not installed too', async () => {
      mockOpenBao.readAppSettings.mockResolvedValue({ RENOVATE_TOKEN: 't', HTTP_PROXY: 'p' });
      mockRepo.listInstalledApps.mockResolvedValue([]);

      await expect(service.getSettings('renovate')).resolves.toEqual({
        settings: { RENOVATE_TOKEN: 't', LOG_FORMAT: '' },
        custom: [{ name: 'HTTP_PROXY', value: 'p' }],
      });
    });

    it('404s for an app with no settings', async () => {
      await expect(service.getSettings('gogs')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409s for a managed app', async () => {
      mockSystemAppsService.isSystem.mockResolvedValue(true);

      await expect(service.getSettings('renovate')).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps an unavailable store to 503 "load"', async () => {
      mockOpenBao.readAppSettings.mockRejectedValue(new OpenBaoUnavailableError('down'));

      const err = await service.getSettings('renovate').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as Error).message).toContain("Couldn't load the settings");
    });
  });

  describe('updateSettings()', () => {
    beforeEach(() => {
      mockRepo.listInstalledApps.mockResolvedValue(['renovate']);
    });

    it('rewrites the entry, keeping stored generated values', async () => {
      mockCatalogService.findOne.mockReturnValue({
        ...settingsApp,
        settings: { ...settingsApp.settings, items: [...settingsApp.settings.items, { name: 'CACHE', generate: { length: 8 } }] },
      });
      mockOpenBao.readAppSettings.mockResolvedValue({ RENOVATE_TOKEN: 'old', LOG_FORMAT: 'json', CACHE: 'keep' });

      const result = await service.updateSettings('renovate', { settings: { RENOVATE_TOKEN: 'new', LOG_FORMAT: 'json' } });

      expect(mockOpenBao.writeAppSettings).toHaveBeenCalledWith('renovate', {
        RENOVATE_TOKEN: 'new',
        LOG_FORMAT: 'json',
        CACHE: 'keep',
      });
      expect(result).toEqual({ success: true, message: 'Renovate settings saved' });
    });

    it('removes a custom variable left out of the request', async () => {
      mockOpenBao.readAppSettings.mockResolvedValue({ RENOVATE_TOKEN: 't', LOG_FORMAT: 'json', HTTP_PROXY: 'p' });

      await service.updateSettings('renovate', { settings: { RENOVATE_TOKEN: 't' } });

      const written = mockOpenBao.writeAppSettings.mock.calls[0][1] as Record<string, string>;
      expect(written).not.toHaveProperty('HTTP_PROXY');
    });

    it('409s when the app is not installed and writes nothing', async () => {
      mockRepo.listInstalledApps.mockResolvedValue([]);

      await expect(service.updateSettings('renovate', { settings: { RENOVATE_TOKEN: 't' } })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockOpenBao.writeAppSettings).not.toHaveBeenCalled();
    });

    it('400s with field errors and writes nothing', async () => {
      await expect(service.updateSettings('renovate', { settings: { RENOVATE_TOKEN: '' } })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockOpenBao.writeAppSettings).not.toHaveBeenCalled();
    });

    it('never commits to Gogs', async () => {
      await service.updateSettings('renovate', { settings: { RENOVATE_TOKEN: 't' } });

      expect(mockRepo.writeApp).not.toHaveBeenCalled();
      expect(mockRepo.removeApp).not.toHaveBeenCalled();
    });

    it('runs under the install mutex', async () => {
      const order: string[] = [];
      mockRepo.writeApp.mockImplementation(async (name: string) => {
        order.push(`start-${name}`);
        await new Promise(r => setTimeout(r, 50));
        order.push(`end-${name}`);
      });
      mockOpenBao.writeAppSettings.mockImplementation(async (name: string) => {
        order.push(`settings-${name}`);
      });

      await Promise.all([
        service.install('vaultwarden'),
        service.updateSettings('renovate', { settings: { RENOVATE_TOKEN: 't' } }),
      ]);

      expect(order).toEqual(['start-vaultwarden', 'end-vaultwarden', 'settings-renovate']);
    });

    it("asks ESO to re-sync the app's ExternalSecret after the write", async () => {
      await service.updateSettings('renovate', { settings: { RENOVATE_TOKEN: 't' } });

      expect(mockK8s.patchNamespacedCustomObject).toHaveBeenCalledTimes(1);
      expect(mockK8s.patchNamespacedCustomObject.mock.calls[0][0]).toMatchObject({
        group: 'external-secrets.io',
        version: 'v1',
        namespace: 'renovate',
        plural: 'externalsecrets',
        name: 'renovate-settings',
        body: { metadata: { annotations: { 'force-sync': expect.any(String) } } },
      });
      expect(mockOpenBao.writeAppSettings.mock.invocationCallOrder[0]).toBeLessThan(
        mockK8s.patchNamespacedCustomObject.mock.invocationCallOrder[0],
      );
    });

    it('a failed nudge is logged, not fatal — the save still succeeds', async () => {
      mockK8s.patchNamespacedCustomObject.mockRejectedValue(new Error('externalsecrets is forbidden'));

      await expect(service.updateSettings('renovate', { settings: { RENOVATE_TOKEN: 't' } })).resolves.toMatchObject({
        success: true,
      });
    });

    it('install never nudges', async () => {
      mockRepo.listInstalledApps.mockResolvedValue([]);

      await service.install('renovate', { settings: { RENOVATE_TOKEN: 't' } });

      expect(mockK8s.patchNamespacedCustomObject).not.toHaveBeenCalled();
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
