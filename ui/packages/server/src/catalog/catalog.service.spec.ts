import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CatalogService } from './catalog.service';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../test/fixtures/catalog.fixture.yaml',
);

describe('CatalogService', () => {
  let service: CatalogService;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        CatalogService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: string) => {
              if (key === 'CATALOG_PATH') return FIXTURE_PATH;
              return defaultValue;
            },
          },
        },
      ],
    }).compile();

    service = module.get<CatalogService>(CatalogService);
    await module.init();
  });

  afterEach(async () => {
    await module.close();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll()', () => {
    it('returns only user-facing apps (no Infrastructure category)', () => {
      const apps = service.findAll();
      const infraApps = apps.filter((app) => app.category === 'Infrastructure');
      expect(infraApps).toHaveLength(0);
    });

    it('returns the correct number of user-facing apps from fixture', () => {
      // fixture has 6 apps, 3 are Infrastructure => 3 user-facing
      const apps = service.findAll();
      expect(apps).toHaveLength(3);
    });

    it('returns apps with all required fields', () => {
      const apps = service.findAll();
      apps.forEach((app) => {
        expect(app).toHaveProperty('name');
        expect(app).toHaveProperty('version');
        expect(app).toHaveProperty('displayName');
        expect(app).toHaveProperty('description');
        expect(app).toHaveProperty('category');
        expect(app).toHaveProperty('icon');
        expect(app).toHaveProperty('sourceType');
        expect(app).toHaveProperty('sourceUrl');
      });
    });

    it('returns known user-facing apps from fixture', () => {
      const apps = service.findAll();
      const names = apps.map((a) => a.name);
      expect(names).toContain('vaultwarden');
      expect(names).toContain('gogs');
      expect(names).toContain('litellm');
    });

    it('does not return infrastructure apps from fixture', () => {
      const apps = service.findAll();
      const names = apps.map((a) => a.name);
      expect(names).not.toContain('traefik');
      expect(names).not.toContain('cert-manager');
      expect(names).not.toContain('nfs-provisioner');
    });
  });

  describe('findOne()', () => {
    it('returns app by name when it exists', () => {
      const app = service.findOne('vaultwarden');
      expect(app).toBeDefined();
      expect(app?.name).toBe('vaultwarden');
      expect(app?.category).toBe('Security');
    });

    it('returns undefined for unknown app name', () => {
      const result = service.findOne('nonexistent-app');
      expect(result).toBeUndefined();
    });

    it('returns undefined for infrastructure app names (filtered out)', () => {
      // Even if you ask for an infrastructure app by name, it should not be found
      const result = service.findOne('traefik');
      expect(result).toBeUndefined();
    });
  });

  describe('hot-reload resilience', () => {
    let tmpDir: string;
    let catalogPath: string;
    let tmpModule: TestingModule;
    let tmpService: CatalogService;

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
      catalogPath = path.join(tmpDir, 'catalog.yaml');
      fs.copyFileSync(FIXTURE_PATH, catalogPath);

      tmpModule = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true })],
        providers: [
          CatalogService,
          {
            provide: ConfigService,
            useValue: {
              get: (key: string, defaultValue?: string) =>
                key === 'CATALOG_PATH' ? catalogPath : defaultValue,
            },
          },
        ],
      }).compile();
      tmpService = tmpModule.get<CatalogService>(CatalogService);
      await tmpModule.init();
    });

    afterEach(async () => {
      await tmpModule.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('keeps the last-good app list when a reload fails', () => {
      const before = tmpService.findAll();
      expect(before).toHaveLength(3);

      fs.writeFileSync(catalogPath, 'apps: [unclosed\n');
      (tmpService as unknown as { loadCatalog: () => void }).loadCatalog();

      expect(tmpService.findAll()).toEqual(before);
    });

    it('retries a failed reload automatically and keeps the last-good list', async () => {
      // compile() WITHOUT init(): onModuleInit never runs, so no fs watcher
      // exists — the only possible automatic re-attempt is the retry timer.
      const retryModule = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true })],
        providers: [
          CatalogService,
          {
            provide: ConfigService,
            useValue: {
              get: (key: string, defaultValue?: string) =>
                key === 'CATALOG_PATH' ? catalogPath : defaultValue,
            },
          },
        ],
      }).compile();
      const retryService = retryModule.get<CatalogService>(CatalogService);
      const internal = retryService as unknown as {
        loadCatalog: () => void;
        retryTimer: unknown;
      };

      internal.loadCatalog();
      expect(retryService.findAll()).toHaveLength(3);

      fs.writeFileSync(catalogPath, 'apps: [unclosed\n');
      internal.loadCatalog();
      // First failure arms the bounded retry; catalog stays last-good.
      expect(internal.retryTimer).not.toBeNull();
      expect(retryService.findAll()).toHaveLength(3);

      // Past the retry window the timer has fired (and, with the file still
      // broken, escalated) — retry no longer armed, list still last-good.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(internal.retryTimer).toBeNull();
      expect(retryService.findAll()).toHaveLength(3);

      await retryModule.close();
    });

    it('swaps the app list when a reload succeeds', () => {
      fs.writeFileSync(
        catalogPath,
        ['apiVersion: marketplace/v1', 'kind: Catalog', 'apps: []'].join('\n'),
      );
      (tmpService as unknown as { loadCatalog: () => void }).loadCatalog();

      expect(tmpService.findAll()).toHaveLength(0);
    });
  });

  describe('kubelet-style ConfigMap volume updates', () => {
    let tmpDir: string;
    let kubeletModule: TestingModule;
    let kubeletService: CatalogService;

    const waitFor = async (cond: () => boolean, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('condition not met within timeout');
    };

    // Reproduces kubelet's atomic-writer layout: the volume dir holds a STABLE
    // `catalog.yaml` symlink pointing at `..data/catalog.yaml` (where `..data`
    // is itself a symlink to a timestamped dir). Updates rename a `..data_tmp`
    // symlink over `..data` — the leaf `catalog.yaml` name NEVER appears in a
    // filesystem event.
    const setupKubeletLayout = () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-kubelet-'));
      const initDir = path.join(tmpDir, '..2026_01_01_00_00_00_init');
      fs.mkdirSync(initDir);
      fs.copyFileSync(FIXTURE_PATH, path.join(initDir, 'catalog.yaml'));
      fs.symlinkSync(path.basename(initDir), path.join(tmpDir, '..data'));
      fs.symlinkSync('..data/catalog.yaml', path.join(tmpDir, 'catalog.yaml'));
    };

    // One atomic kubelet update: new timestamped dir, new ..data symlink
    // renamed over the old one.
    const kubeletUpdate = (content: string) => {
      const newDir = path.join(tmpDir, '..2026_01_01_00_00_00.000000000');
      fs.mkdirSync(newDir);
      fs.writeFileSync(path.join(newDir, 'catalog.yaml'), content);
      const tmpLink = path.join(tmpDir, '..data_tmp');
      fs.symlinkSync(path.basename(newDir), tmpLink);
      fs.renameSync(tmpLink, path.join(tmpDir, '..data'));
    };

    afterEach(async () => {
      await kubeletModule.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reloads when the ..data symlink is swapped (never touches catalog.yaml)', async () => {
      setupKubeletLayout();
      kubeletModule = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true })],
        providers: [
          CatalogService,
          {
            provide: ConfigService,
            useValue: {
              get: (key: string, defaultValue?: string) =>
                key === 'CATALOG_PATH'
                  ? path.join(tmpDir, 'catalog.yaml')
                  : defaultValue,
            },
          },
        ],
      }).compile();
      kubeletService = kubeletModule.get<CatalogService>(CatalogService);
      await kubeletModule.init();
      expect(kubeletService.findAll()).toHaveLength(3);

      kubeletUpdate(
        ['apiVersion: marketplace/v1', 'kind: Catalog', 'apps: []'].join('\n'),
      );

      await waitFor(() => kubeletService.findAll().length === 0);
    });
  });
});
