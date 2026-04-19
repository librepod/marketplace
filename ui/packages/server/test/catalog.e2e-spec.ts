import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as path from 'node:path';
import { AppModule } from '../src/app.module';

// Point to test fixture instead of real catalog.yaml
process.env.CATALOG_PATH = path.resolve(
  __dirname,
  'fixtures/catalog.fixture.yaml',
);

describe('Catalog API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/apps', () => {
    it('returns 200 with an array of apps', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/apps')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('does not include Infrastructure apps', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/apps')
        .expect(200);

      response.body.forEach((app: { category: string }) => {
        expect(app.category).not.toBe('Infrastructure');
      });
    });

    it('returns exactly 3 user-facing apps from fixture', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/apps')
        .expect(200);

      // fixture has 6 apps, 3 infrastructure, so 3 user-facing
      expect(response.body).toHaveLength(3);
    });

    it('each app has required fields', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/apps')
        .expect(200);

      response.body.forEach((app: Record<string, unknown>) => {
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
  });

  describe('GET /api/apps/:name', () => {
    it('returns 200 with app data for known app', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/apps/vaultwarden')
        .expect(200);

      expect(response.body.name).toBe('vaultwarden');
      expect(response.body.category).toBe('Security');
    });

    it('returns 404 for unknown app name', async () => {
      await request(app.getHttpServer())
        .get('/api/apps/nonexistent-app')
        .expect(404);
    });

    it('returns 404 for infrastructure app name (filtered out)', async () => {
      await request(app.getHttpServer())
        .get('/api/apps/traefik')
        .expect(404);
    });
  });

  describe('GET /api/health', () => {
    it('returns 200', async () => {
      await request(app.getHttpServer())
        .get('/api/health')
        .expect(200);
    });
  });
});
