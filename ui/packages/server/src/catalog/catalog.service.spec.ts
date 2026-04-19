import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
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
});
