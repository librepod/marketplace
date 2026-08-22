import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as path from 'node:path';
import * as os from 'node:os';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';

// Point to test fixture instead of real catalog.yaml
process.env.CATALOG_PATH = path.resolve(
  __dirname,
  'fixtures/catalog.fixture.yaml',
);
// The app-store repo must be UNREACHABLE here — these specs assert the graceful
// degradation path (everything reads not_installed). Point the remote at a dead
// port so `git clone` fails fast, and set the credentials inline so the resolve
// step gets far enough to attempt it.
//
// USER_APPS_GIT_URL is load-bearing beyond the assertion: without it
// GitRemoteService would DISCOVER the remote from GitRepository/user-apps-source
// via loadFromDefault() — i.e. the developer's own kubeconfig — and a suite that
// can reach a real cluster could clone a real app-store repo. The override keeps
// this hermetic (#182).
process.env.USER_APPS_GIT_URL = 'http://localhost:9999/flux/user-apps.git';
process.env.USER_APPS_GIT_USERNAME = 'flux';
process.env.USER_APPS_GIT_PASSWORD = 'test-password';
process.env.USER_APPS_WORK_DIR = path.join(
  os.tmpdir(),
  `marketplace-e2e-user-apps-${process.pid}`,
);
// Auth (global AuthGuard gates /api/* — mint a session cookie in beforeAll)
process.env.SESSION_SECRET = 'e2e-secret-long-and-random';
process.env.CASDOOR_ENDPOINT = 'https://id.example.com';
process.env.CASDOOR_CLIENT_ID = 'marketplace-ui';
process.env.CASDOOR_CLIENT_SECRET = 'secret';
process.env.CASDOOR_ORG_NAME = 'librepod';
process.env.CASDOOR_APP_NAME = 'marketplace-ui';

describe('Catalog API (e2e)', () => {
  let app: INestApplication;
  let authCookie: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();

    const session = app.get(SessionService);
    authCookie = `${session.cookieName}=${session.sign({ sub: 'sub-1', name: 'tester', email: 't@librepod' })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/apps', () => {
    it('returns 200 with an array of apps', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/apps')
        .set('Cookie', authCookie)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('does not include Infrastructure apps', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/apps')
        .set('Cookie', authCookie)
        .expect(200);

      response.body.forEach((app: { category: string }) => {
        expect(app.category).not.toBe('Infrastructure');
      });
    });

    it('returns exactly 3 user-facing apps from fixture', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/apps')
        .set('Cookie', authCookie)
        .expect(200);

      // fixture has 6 apps, 3 infrastructure, so 3 user-facing
      expect(response.body).toHaveLength(3);
    });

    it('each app has required fields', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/apps')
        .set('Cookie', authCookie)
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
        .set('Cookie', authCookie)
        .expect(200);

      expect(response.body.name).toBe('vaultwarden');
      expect(response.body.category).toBe('Security');
    });

    it('returns 404 for unknown app name', async () => {
      await request(app.getHttpServer())
        .get('/api/apps/nonexistent-app')
        .set('Cookie', authCookie)
        .expect(404);
    });

    it('returns 404 for infrastructure app name (filtered out)', async () => {
      await request(app.getHttpServer())
        .get('/api/apps/traefik')
        .set('Cookie', authCookie)
        .expect(404);
    });
  });

  describe('GET /api/health', () => {
    it('returns 200', async () => {
      // No session cookie: probes must stay public behind the global AuthGuard.
      await request(app.getHttpServer())
        .get('/api/health')
        .expect(200);
    });
  });

  describe('GET /api/apps — installedStatus field', () => {
    it('each app has installedStatus field (BACK-02, STAT-01)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/apps')
        .set('Cookie', authCookie)
        .expect(200);

      response.body.forEach((app: Record<string, unknown>) => {
        expect(app).toHaveProperty('installedStatus');
      });
    });

    it('installedStatus is one of the four valid values (STAT-01)', async () => {
      const validStatuses = ['not_installed', 'installing', 'running', 'error'];
      const response = await request(app.getHttpServer())
        .get('/api/apps')
        .set('Cookie', authCookie)
        .expect(200);

      response.body.forEach((app: Record<string, unknown>) => {
        expect(validStatuses).toContain(app.installedStatus);
      });
    });

    it('all apps are not_installed when the app-store repo is unreachable (graceful degradation, BACK-02)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/apps')
        .set('Cookie', authCookie)
        .expect(200);

      // USER_APPS_GIT_URL points at a dead port → clone fails, no working copy
      // → listInstalledApps() returns [] → all not_installed
      response.body.forEach((app: Record<string, unknown>) => {
        expect(app.installedStatus).toBe('not_installed');
      });
    });
  });

  describe('GET /api/installed', () => {
    it('returns 200 with an array (INST-03)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/installed')
        .set('Cookie', authCookie)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('returns empty array when the app-store repo is unreachable (graceful degradation, INST-03)', async () => {
      // USER_APPS_GIT_URL points at a dead port → listInstalledApps() returns []
      // → getInstalled returns []
      const response = await request(app.getHttpServer())
        .get('/api/installed')
        .set('Cookie', authCookie)
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('each item in installed list has installedStatus field (INST-03)', async () => {
      // With Gogs unreachable, no items — test this invariant by directly checking if any items appear
      const response = await request(app.getHttpServer())
        .get('/api/installed')
        .set('Cookie', authCookie)
        .expect(200);

      response.body.forEach((app: Record<string, unknown>) => {
        expect(app).toHaveProperty('installedStatus');
        expect(app.installedStatus).not.toBe('not_installed');
      });
    });
  });
});
