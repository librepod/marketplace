import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WgPeer } from '@librepod/shared';
import { BootstrapController } from './bootstrap.controller';
import { SessionService } from '../auth/session.service';
import type { OnboardingRecord, OnboardingStore } from './onboarding-store';
import type { OnboardingService } from './onboarding.service';
import type { CasdoorAdminService } from './casdoor-admin.service';
import type { WgEasyService } from './wg-easy.service';
import type { InstalledService } from '../installed/installed.service';
import type { NodeAddressService } from '../installed/node-address.service';

const claimed: OnboardingRecord = {
  state: 'claimed', code: '7KQMX3RT9VHC', generation: 3, account: null, accountGeneration: null,
  createdAt: '2026-10-14T09:00:00.000Z', claimedAt: '2026-10-14T10:00:00.000Z', finishedAt: null, version: 4,
};

let session: SessionService;
beforeAll(() => {
  process.env.SESSION_SECRET = 'bootstrap-controller-spec';
  session = new SessionService();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BOOTSTRAP_MODE_OVERRIDE;
  delete process.env.ROOT_CA_PATH;
});

function make(o: {
  record?: OnboardingRecord | Error;
  knownFinished?: boolean;
  reachable?: boolean;
  vpn?: string | Error;
  peers?: WgPeer[] | Error;
  deviceIp?: string | Error;
} = {}) {
  const value = <T>(v: T | Error): T => {
    if (v instanceof Error) throw v;
    return v;
  };
  const store = {
    record: vi.fn(async () => value(o.record ?? claimed)),
    finishIfClaimed: vi.fn(async () => false),
    knownFinished: o.knownFinished ?? false,
  };
  const onboarding = {
    claim: vi.fn(async () => claimed),
    resume: vi.fn(async () => claimed),
    account: vi.fn(async () => claimed),
  };
  const casdoor = { reachable: vi.fn(async () => o.reachable ?? true) };
  const wgEasy = { listClients: vi.fn(async () => value(o.peers ?? [])) };
  const installed = {
    appStatus: vi.fn(async () => value(o.vpn ?? 'not_installed')),
    install: vi.fn(async () => ({ success: true, message: 'WG Easy is being deployed' })),
  };
  const nodeAddress = { internalIp: vi.fn(async () => value(o.deviceIp ?? '192.168.1.50')) };
  const controller = new BootstrapController(
    onboarding as unknown as OnboardingService,
    store as unknown as OnboardingStore,
    casdoor as unknown as CasdoorAdminService,
    wgEasy as unknown as WgEasyService,
    session,
    new ConfigService({ BASE_DOMAIN: 'libre.pod' }),
    installed as unknown as InstalledService,
    nodeAddress as unknown as NodeAddressService,
  );
  return { controller, store, onboarding, casdoor, wgEasy, installed, nodeAddress };
}

function req(host: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return { headers: { 'x-forwarded-host': host, ...headers }, cookies, ip: '10.0.0.9' } as unknown as Request;
}
const withCookie = (generation = 3) => ({
  mp_onboarding: session.sign({ sub: 'onboarding', name: 'onboarding', email: '', generation }),
});
function fakeRes() {
  return { cookie: vi.fn(), setHeader: vi.fn(), send: vi.fn() } as unknown as Response & {
    cookie: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
}

describe('BootstrapController.status', () => {
  it('BOOTSTRAP_MODE_OVERRIDE forces the state without reading anything (Tier 1)', async () => {
    process.env.BOOTSTRAP_MODE_OVERRIDE = 'finished';
    const { controller, store, casdoor } = make();
    expect((await controller.status(req('localhost'))).state).toBe('finished');
    expect(store.record).not.toHaveBeenCalled();
    expect(casdoor.reachable).not.toHaveBeenCalled();
  });

  it('a signed-in user gets the app — finished — even with OpenBao down; the finish write is retried', async () => {
    const { controller, store } = make({ record: new Error('sealed') });
    const sso = { mp_session: session.sign({ sub: 'alex', name: 'alex', email: 'alex@libre.pod' }) };
    expect(await controller.status(req('libre.pod', sso))).toMatchObject({ state: 'finished', arrival: 'domain' });
    expect(store.finishIfClaimed).toHaveBeenCalledWith(expect.any(Number));
  });

  it('the onboarding token in the session cookie is not a signed-in user', async () => {
    const { controller, store } = make({ record: { ...claimed, state: 'open' } });
    const status = await controller.status(req('libre.pod', { mp_session: withCookie().mp_onboarding }));
    expect(status.state).toBe('open');
    expect(store.finishIfClaimed).not.toHaveBeenCalled();
  });

  it('waiting while OpenBao cannot answer', async () => {
    expect((await make({ record: new Error('sealed') }).controller.status(req('192.168.1.50'))).state).toBe('waiting');
  });

  it('a device last seen finished stays finished while OpenBao cannot answer: a signed-out visitor still gets the sign-in', async () => {
    const { controller, casdoor } = make({ record: new Error('sealed'), knownFinished: true });
    expect(await controller.status(req('libre.pod'))).toMatchObject({ state: 'finished', arrival: 'domain', session: false });
    expect((await controller.status(req('192.168.1.50'))).state).toBe('finished');
    expect(casdoor.reachable).not.toHaveBeenCalled();
  });

  it('waiting while Casdoor is down before onboarding finishes; finished needs no Casdoor', async () => {
    const open = make({ record: { ...claimed, state: 'open' }, reachable: false });
    expect((await open.controller.status(req('192.168.1.50'))).state).toBe('waiting');
    const finished = make({ record: { ...claimed, state: 'finished' }, reachable: false });
    expect((await finished.controller.status(req('192.168.1.50'))).state).toBe('finished');
    expect(finished.casdoor.reachable).not.toHaveBeenCalled();
  });

  it('IPv4 and IPv6 literals are ip arrivals; names are domain arrivals', async () => {
    const { controller } = make({ record: { ...claimed, state: 'open' } });
    for (const host of ['192.168.1.50', '192.168.1.50:8080', '[2001:db8::1]', '[2001:db8::1]:8080']) {
      expect((await controller.status(req(host))).arrival).toBe('ip');
    }
    for (const host of ['libre.pod', 'marketplace.libre.pod', 'localhost']) {
      expect((await controller.status(req(host))).arrival).toBe('domain');
    }
  });

  it('without the onboarding cookie: the state only — nothing read from the VPN', async () => {
    const { controller, installed, wgEasy } = make();
    expect(await controller.status(req('192.168.1.50'))).toEqual({
      state: 'claimed', arrival: 'ip', baseDomain: 'libre.pod', session: false, account: null,
      previousAccount: null, vpnStatus: null, peerCount: null, lastHandshakeAt: null, endpointSuggestion: null,
    });
    expect(installed.appStatus).not.toHaveBeenCalled();
    expect(wgEasy.listClients).not.toHaveBeenCalled();
  });

  it('a cookie from another generation (a reset since) is no session', async () => {
    expect((await make().controller.status(req('192.168.1.50', withCookie(2)))).session).toBe(false);
  });

  it('with the cookie: VPN telemetry with the latest handshake, and the arrival IP as endpoint', async () => {
    const peers: WgPeer[] = [
      { clientId: 'a', name: 'phone', enabled: true, latestHandshakeAt: '2026-10-14T10:00:00Z' },
      { clientId: 'b', name: 'laptop', enabled: true, latestHandshakeAt: '2026-10-14T09:00:00Z' },
    ];
    const { controller } = make({ vpn: 'running', peers });
    expect(await controller.status(req('192.168.1.50', withCookie()))).toMatchObject({
      session: true, vpnStatus: 'running', peerCount: 2, lastHandshakeAt: '2026-10-14T10:00:00Z',
      endpointSuggestion: '192.168.1.50',
    });
  });

  it('not installed: no wg-easy call; rolling out and not answering: still answers; status read failing: null', async () => {
    const notInstalled = make({ vpn: 'not_installed' });
    expect((await notInstalled.controller.status(req('192.168.1.50', withCookie()))).peerCount).toBeNull();
    expect(notInstalled.wgEasy.listClients).not.toHaveBeenCalled();

    const rolling = make({ vpn: 'installing', peers: new Error('503') });
    expect(await rolling.controller.status(req('192.168.1.50', withCookie()))).toMatchObject({
      vpnStatus: 'installing', peerCount: null,
    });

    const unknown = make({ vpn: new Error('git unreachable') });
    expect((await unknown.controller.status(req('192.168.1.50', withCookie()))).vpnStatus).toBeNull();
  });

  it('an account confirmed since the claim is `account`; one kept from before a reset is `previousAccount`', async () => {
    const confirmed = make({ record: { ...claimed, account: 'alex', accountGeneration: 3 } });
    expect(await confirmed.controller.status(req('192.168.1.50', withCookie()))).toMatchObject({
      account: 'alex', previousAccount: null,
    });
    const kept = make({ record: { ...claimed, account: 'alex', accountGeneration: 1 } });
    expect(await kept.controller.status(req('192.168.1.50', withCookie()))).toMatchObject({
      account: null, previousAccount: 'alex',
    });
  });

  it('endpoint: loopback, link-local and name arrivals fall back to DEVICE_IP; a failed lookup is null', async () => {
    for (const host of ['127.0.0.1', '169.254.10.1', '[::1]', '[fe80::1]', 'libre.pod']) {
      expect((await make().controller.status(req(host, withCookie()))).endpointSuggestion).toBe('192.168.1.50');
    }
    const lost = make({ deviceIp: new ServiceUnavailableException('no node') });
    expect((await lost.controller.status(req('127.0.0.1', withCookie()))).endpointSuggestion).toBeNull();
  });
});

describe('BootstrapController.claim / resume', () => {
  it('claim sets the onboarding cookie for the record\'s generation — httpOnly, lax, not Secure', async () => {
    const { controller, onboarding } = make();
    const res = fakeRes();
    await expect(controller.claim({ code: 'c', password: 'p' }, req('192.168.1.50'), res)).resolves.toEqual({ ok: true });
    expect(onboarding.claim).toHaveBeenCalledWith({ code: 'c', password: 'p' }, '10.0.0.9');
    const [name, token, opts] = res.cookie.mock.calls[0];
    expect(name).toBe('mp_onboarding');
    expect(session.verify(token)).toMatchObject({ sub: 'onboarding', generation: 3 });
    expect(opts).toEqual({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: session.ttlSeconds * 1000 });
  });

  it('logs the first X-Forwarded-For address as the source', async () => {
    const { controller, onboarding } = make();
    await controller.claim({}, req('192.168.1.50', {}, { 'x-forwarded-for': '192.168.1.20, 10.42.0.1' }), fakeRes());
    expect(onboarding.claim).toHaveBeenCalledWith({ code: undefined, password: undefined }, '192.168.1.20');
  });

  it('a refused claim sets no cookie', async () => {
    const { controller, onboarding } = make();
    onboarding.claim.mockRejectedValueOnce(new ConflictException('already claimed'));
    const res = fakeRes();
    await expect(controller.claim({ code: 'c', password: 'p' }, req('192.168.1.50'), res)).rejects.toThrow(
      ConflictException,
    );
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('resume sets the cookie when the code is right', async () => {
    const { controller, onboarding } = make();
    const res = fakeRes();
    await controller.resume({ code: 'c' }, req('192.168.1.50'), res);
    expect(onboarding.resume).toHaveBeenCalledWith('c', '10.0.0.9');
    expect(res.cookie).toHaveBeenCalledWith('mp_onboarding', expect.any(String), expect.anything());
  });
});

describe('BootstrapController.account', () => {
  it('delegates username and password', async () => {
    const { controller, onboarding } = make();
    await expect(controller.account({ username: 'alex', password: 'personal-pass-12' })).resolves.toEqual({ ok: true });
    expect(onboarding.account).toHaveBeenCalledWith({ username: 'alex', password: 'personal-pass-12' });
  });
});

describe('BootstrapController.install', () => {
  it('forwards the answers unchanged: no INIT_PASSWORD is injected', async () => {
    const { controller, installed } = make();
    await controller.install({ app: 'wg-easy', settings: { INIT_HOST: '203.0.113.7' } });
    expect(installed.install).toHaveBeenCalledWith('wg-easy', { settings: { INIT_HOST: '203.0.113.7' } });
  });

  it('only VPN apps', async () => {
    const { controller, installed } = make();
    for (const body of [{ app: 'vaultwarden' }, { app: '__proto__' }, { app: 'constructor' }, { app: 42 }, {}, undefined]) {
      await expect(controller.install(body as never)).rejects.toThrow(BadRequestException);
    }
    expect(installed.install).not.toHaveBeenCalled();
  });

  it('an endpoint host with a port or a scheme is an INIT_HOST field error', async () => {
    const { controller, installed } = make();
    for (const host of ['203.0.113.5:51820', 'http://vpn.example.com', 'vpn.example.com/', '2001:db8::1']) {
      const err = await controller.install({ app: 'wg-easy', settings: { INIT_HOST: host } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({ errors: [{ name: 'INIT_HOST' }] });
    }
    expect(installed.install).not.toHaveBeenCalled();
    await controller.install({ app: 'wg-easy', settings: { INIT_HOST: 'vpn.example.com' } });
    expect(installed.install).toHaveBeenCalledOnce();
  });

  it('settings that are not an object are dropped, never spread', async () => {
    const { controller, installed } = make();
    await controller.install({ app: 'wg-easy', settings: ['x'] as never });
    expect(installed.install).toHaveBeenCalledWith('wg-easy', { settings: {} });
  });

  it('install errors pass through unchanged (the wizard counts 409 as success)', async () => {
    const { controller, installed } = make();
    installed.install.mockRejectedValueOnce(new ConflictException('WG Easy is already installed'));
    await expect(controller.install({ app: 'wg-easy' })).rejects.toThrow(ConflictException);
  });
});

describe('BootstrapController.ca', () => {
  it('streams the mounted root CA with download headers', () => {
    // a real temp file — the node:fs namespace is frozen and cannot be spied
    const dir = mkdtempSync(join(tmpdir(), 'root-ca-'));
    const file = join(dir, 'root_ca.crt');
    writeFileSync(file, '-----BEGIN CERTIFICATE-----\n…');
    process.env.ROOT_CA_PATH = file;
    try {
      const res = fakeRes();
      make().controller.ca(res);
      expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/x-x509-ca-cert');
      expect(res.send).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('404s when the CA is not mounted', () => {
    process.env.ROOT_CA_PATH = '/nonexistent/root_ca.crt';
    expect(() => make().controller.ca(fakeRes())).toThrow(NotFoundException);
  });
});
