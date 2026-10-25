import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { Logger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { BootstrapController } from '../src/onboarding/bootstrap.controller';
import { WireguardController } from '../src/onboarding/wireguard.controller';
import { OnboardingGuard } from '../src/onboarding/onboarding.guard';
import { OnboardingService } from '../src/onboarding/onboarding.service';
import { OnboardingStore } from '../src/onboarding/onboarding-store';
import { CasdoorAdminService } from '../src/onboarding/casdoor-admin.service';
import { WgEasyService } from '../src/onboarding/wg-easy.service';
import { formatSetupCode } from '../src/onboarding/setup-code';
import { SessionService } from '../src/auth/session.service';
import { InstalledService } from '../src/installed/installed.service';
import { NodeAddressService } from '../src/installed/node-address.service';
import { OpenBaoUnavailableError, type OpenBaoClient } from '../src/installed/openbao.client';
import { FakeKv } from './fixtures/fake-kv';
import { fakeCasdoor } from './fixtures/fake-casdoor';

// HTTP-level on purpose: decorators (@Body, @UseGuards, @HttpCode) are invisible
// to unit tests that call controller methods directly. Real store, service, guard
// and SessionService; OpenBao, Casdoor, the installer and wg-easy are faked.
process.env.SESSION_SECRET = 'onboarding-e2e-secret';

const ADMIN = 'admin-password-12';

async function boot() {
  const kv = new FakeKv();
  const { casdoor, state } = fakeCasdoor();
  const installed = {
    install: vi.fn(async () => ({ success: true, message: 'WG Easy is being deployed' })),
    appStatus: vi.fn(async () => 'not_installed'),
  };
  const wgEasy = { listClients: vi.fn(async () => []), createClient: vi.fn(async () => ({ clientId: 'c1' })) };
  const moduleRef = await Test.createTestingModule({
    controllers: [BootstrapController, WireguardController],
    providers: [
      OnboardingService,
      OnboardingGuard,
      SessionService,
      {
        provide: OnboardingStore,
        useFactory: () => new OnboardingStore(kv as unknown as OpenBaoClient, new ConfigService({})),
      },
      { provide: CasdoorAdminService, useValue: casdoor },
      { provide: InstalledService, useValue: installed },
      { provide: WgEasyService, useValue: wgEasy },
      { provide: NodeAddressService, useValue: { internalIp: vi.fn(async () => '192.168.1.50') } },
      { provide: ConfigService, useValue: new ConfigService({ BASE_DOMAIN: 'libre.pod' }) },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  // init starts the Casdoor sync in the background; a test's first claim must not race it.
  await vi.waitFor(() => expect(state.groupExists).toBe(true));
  const store = app.get(OnboardingStore);
  return { app, server: app.getHttpServer(), kv, casdoor, state, installed, store };
}

function onboardingCookie(res: request.Response): string {
  const raw = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const cookie = raw.find((c) => c.startsWith('mp_onboarding='));
  if (!cookie) throw new Error('no onboarding cookie in the response');
  return cookie.split(';')[0];
}

describe('Onboarding API (e2e)', () => {
  let t: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    t = await boot();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.app.close();
    vi.restoreAllMocks();
  });

  it('open → claim → account → install → first sign-in → closed for good', async () => {
    const fresh = await request(t.server).get('/bootstrap/status').expect(200);
    expect(fresh.body).toMatchObject({ state: 'open', arrival: 'ip', session: false, account: null, vpnStatus: null });
    expect(fresh.headers['set-cookie']).toBeUndefined();

    const { code } = await t.store.record();
    await request(t.server).post('/bootstrap/claim').send({ code: 'AAAA-BBBB-CCCC', password: ADMIN }).expect(403);
    const claim = await request(t.server)
      .post('/bootstrap/claim')
      .send({ code: formatSetupCode(code).toLowerCase(), password: ADMIN })
      .expect(200);
    const setCookie = (claim.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('mp_onboarding='))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Secure/i);
    const cookie = onboardingCookie(claim);
    expect(t.state.adminPassword).toBe(ADMIN);

    const mine = await request(t.server).get('/bootstrap/status').set('Cookie', cookie).expect(200);
    // supertest's Host is 127.0.0.1 — loopback, so the endpoint falls back to DEVICE_IP
    expect(mine.body).toMatchObject({
      state: 'claimed', session: true, account: null, previousAccount: null, vpnStatus: 'not_installed',
      endpointSuggestion: '192.168.1.50',
    });
    const stranger = await request(t.server).get('/bootstrap/status').expect(200);
    expect(stranger.body).toMatchObject({ state: 'claimed', session: false, vpnStatus: null, endpointSuggestion: null });

    await request(t.server)
      .post('/bootstrap/account')
      .set('Cookie', cookie)
      .send({ username: 'alex', password: 'personal-pass-12' })
      .expect(200);
    expect(t.state.users.get('alex')).toBe('personal-pass-12');
    expect(t.state.admins.has('alex')).toBe(true);
    expect(t.state.adminPassword).toBe(t.kv.get('system', 'admin')?.password);

    await request(t.server)
      .post('/bootstrap/install')
      .set('Cookie', cookie)
      .send({ app: 'wg-easy', settings: { INIT_HOST: '203.0.113.7' } })
      .expect(200);
    expect(t.installed.install).toHaveBeenCalledWith('wg-easy', {
      settings: { INIT_HOST: '203.0.113.7' },
    });
    expect((await request(t.server).get('/bootstrap/status').set('Cookie', cookie)).body.account).toBe('alex');

    // What the SSO callback runs (AuthController): the first sign-in since the claim.
    expect(await t.store.finishIfClaimed('alex')).toBe(true);
    expect((await request(t.server).get('/bootstrap/status').set('Cookie', cookie)).body).toMatchObject({
      state: 'finished', session: false, account: null,
    });
    await request(t.server).post('/bootstrap/account').set('Cookie', cookie).send({ username: 'alex' }).expect(401);
    await request(t.server).post('/bootstrap/install').set('Cookie', cookie).send({ app: 'wg-easy' }).expect(401);
    await request(t.server).get('/bootstrap/wireguard').set('Cookie', cookie).expect(401);
    await request(t.server).post('/bootstrap/claim').send({ code, password: ADMIN }).expect(409);
    await request(t.server).post('/bootstrap/resume').send({ code }).expect(409);
  });

  it('a reset reopens onboarding with a new code and retires every older cookie', async () => {
    const first = (await t.store.record()).code;
    const cookie = onboardingCookie(
      await request(t.server).post('/bootstrap/claim').send({ code: first, password: ADMIN }).expect(200),
    );
    await request(t.server)
      .post('/bootstrap/account')
      .set('Cookie', cookie)
      .send({ username: 'alex', password: 'personal-pass-12' })
      .expect(200);

    const second = await t.store.reset(); // what `reset-onboarding` runs
    expect(second).not.toBe(first);
    expect((await request(t.server).get('/bootstrap/status').set('Cookie', cookie)).body).toMatchObject({
      state: 'open', session: false,
    });
    await request(t.server).post('/bootstrap/account').set('Cookie', cookie).send({ username: 'alex' }).expect(401);
    await request(t.server).post('/bootstrap/claim').send({ code: first, password: 'new-admin-pass-12' }).expect(403);

    const fresh = onboardingCookie(
      await request(t.server).post('/bootstrap/claim').send({ code: second, password: 'new-admin-pass-12' }).expect(200),
    );
    expect(t.state.adminPassword).toBe('new-admin-pass-12');
    expect((await request(t.server).get('/bootstrap/status').set('Cookie', fresh)).body).toMatchObject({
      state: 'claimed', session: true, account: null, previousAccount: 'alex',
    });
    // The forgotten personal password: keep alex, set a new one.
    await request(t.server)
      .post('/bootstrap/account')
      .set('Cookie', fresh)
      .send({ username: 'alex', password: 'brand-new-pass-12' })
      .expect(200);
    expect(t.state.users.get('alex')).toBe('brand-new-pass-12');
  });

  it('resume: the right code brings another browser back into a claimed setup', async () => {
    const { code } = await t.store.record();
    await request(t.server).post('/bootstrap/claim').send({ code, password: ADMIN }).expect(200);
    await request(t.server).post('/bootstrap/resume').send({ code: 'AAAA-BBBB-CCCC' }).expect(403);
    const cookie = onboardingCookie(await request(t.server).post('/bootstrap/resume').send({ code }).expect(200));
    expect((await request(t.server).get('/bootstrap/status').set('Cookie', cookie)).body.session).toBe(true);
  });

  it('malformed or missing bodies are 4xx, never 500', async () => {
    const { code } = await t.store.record();
    await request(t.server).post('/bootstrap/claim').expect(403);
    await request(t.server).post('/bootstrap/claim').send({ code: 42, password: ADMIN }).expect(403);
    await request(t.server).post('/bootstrap/claim').send({ code, password: 123456789012 }).expect(400);
    await request(t.server).post('/bootstrap/claim').send({ code, password: 'elevenchars' }).expect(400);
    const cookie = onboardingCookie(
      await request(t.server).post('/bootstrap/claim').send({ code, password: ADMIN }).expect(200),
    );
    await request(t.server).post('/bootstrap/resume').expect(403);
    await request(t.server).post('/bootstrap/account').set('Cookie', cookie).expect(400);
    await request(t.server).post('/bootstrap/account').set('Cookie', cookie).send({ username: ['alex'] }).expect(400);
    await request(t.server).post('/bootstrap/install').set('Cookie', cookie).expect(400);
    await request(t.server).post('/bootstrap/install').set('Cookie', cookie).send({ app: '__proto__' }).expect(400);
    await request(t.server).post('/bootstrap/wireguard/peer').set('Cookie', cookie).send({ name: 42 }).expect(400);
    expect(t.installed.install).not.toHaveBeenCalled();
  });

  it('OpenBao down: status says waiting; resume and cookie-gated calls are 503', async () => {
    const { code } = await t.store.record();
    const cookie = onboardingCookie(
      await request(t.server).post('/bootstrap/claim').send({ code, password: ADMIN }).expect(200),
    );
    t.kv.failWith = new OpenBaoUnavailableError('sealed');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6_000); // past the store's 5-second cache
    expect((await request(t.server).get('/bootstrap/status')).body.state).toBe('waiting');
    await request(t.server).post('/bootstrap/resume').send({ code }).expect(503);
    await request(t.server)
      .post('/bootstrap/account')
      .set('Cookie', cookie)
      .send({ username: 'alex', password: 'personal-pass-12' })
      .expect(503);
  });

  it('Casdoor down before onboarding finishes: status says waiting', async () => {
    t.casdoor.reachable.mockResolvedValue(false);
    expect((await request(t.server).get('/bootstrap/status')).body.state).toBe('waiting');
  });
});
