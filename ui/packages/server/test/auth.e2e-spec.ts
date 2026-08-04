import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';

// Auth e2e does not hit real Casdoor: it verifies the session-cookie contract
// (login sets state cookie + redirects; a valid session unlocks /api/*).
process.env.SESSION_SECRET = 'e2e-secret-long-and-random';
process.env.CASDOOR_ENDPOINT = 'https://id.example.com';
process.env.CASDOOR_CLIENT_ID = 'marketplace-ui';
process.env.CASDOOR_CLIENT_SECRET = 'secret';
process.env.CASDOOR_ORG_NAME = 'librepod';
process.env.CASDOOR_APP_NAME = 'marketplace-ui';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let session: SessionService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    await app.init();
    session = app.get(SessionService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/me without session → 401', async () => {
    await request(app.getHttpServer()).get('/api/me').expect(401);
  });

  it('GET /api/apps without session → 401', async () => {
    await request(app.getHttpServer()).get('/api/apps').expect(401);
  });

  it('GET /api/auth/login redirects to Casdoor with a state cookie', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/login')
      .set('X-Forwarded-Host', 'marketplace.example.com')
      .expect(302);
    const loc = res.headers.location as string;
    expect(loc).toContain('https://id.example.com/login/oauth/authorize');
    expect(loc).toContain('redirect_uri=https%3A%2F%2Fmarketplace.example.com%2Fapi%2Fauth%2Fcallback');
    // superagent types headers as Record<string,string>, but set-cookie is
    // actually string[] at runtime — cast through unknown (its typings are
    // incomplete for multi-valued headers).
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie.join(';')).toContain('mp_oauth_state=');
  });

  it('GET /api/auth/callback rejects a bad state → 400', async () => {
    await request(app.getHttpServer())
      .get('/api/auth/callback?code=x&state=bad')
      .expect(400);
  });

  it('GET /api/me with a valid session cookie → 200 and returns identity', async () => {
    const token = session.sign({ sub: 'sub-1', name: 'alice', email: 'alice@librepod' });
    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Cookie', `${session.cookieName}=${token}`)
      .expect(200);
    expect(res.body).toEqual({ sub: 'sub-1', name: 'alice', email: 'alice@librepod' });
  });

  it('GET /api/apps with a valid session cookie → 200', async () => {
    const token = session.sign({ sub: 'sub-1', name: 'alice', email: 'alice@librepod' });
    await request(app.getHttpServer())
      .get('/api/apps')
      .set('Cookie', `${session.cookieName}=${token}`)
      .expect(200);
  });

  it('GET /api/auth/logout clears the session cookie and redirects to login', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/logout').expect(302);
    expect(res.headers.location).toBe('/api/auth/login');
    // superagent types headers as Record<string,string>, but set-cookie is
    // actually string[] at runtime — cast through unknown (its typings are
    // incomplete for multi-valued headers).
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie.join(';').toLowerCase()).toContain('mp_session=;');
  });
});
