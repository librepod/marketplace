import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { BootstrapController } from './bootstrap.controller';
import type { CasdoorAdminService } from './casdoor-admin.service';
import type { WgEasyService } from './wg-easy.service';
import type { SessionService } from '../auth/session.service';
import type { WgPeer } from '@librepod/shared';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeController(overrides: {
  probe?: ReturnType<typeof vi.fn>;
  claim?: ReturnType<typeof vi.fn>;
  wg?: Partial<WgEasyService>;
}) {
  const casdoorAdmin = {
    probeFactoryLogin: overrides.probe ?? vi.fn(),
    claim: overrides.claim ?? vi.fn(),
  } as unknown as CasdoorAdminService;
  const wgEasy = { listClients: vi.fn(), ensurePassword: vi.fn(), ...(overrides.wg ?? {}) } as unknown as WgEasyService;
  const session = {
    sign: vi.fn().mockReturnValue('signed-token'),
    verify: vi.fn(),
    ttlSeconds: 8 * 60 * 60,
    cookieName: 'mp_session',
  } as unknown as SessionService;
  const controller = new BootstrapController(casdoorAdmin, wgEasy, session, new ConfigService({ BASE_DOMAIN: 'libre.pod' }));
  return { controller, casdoorAdmin, wgEasy, session };
}

function fakeRes() {
  const cookies: Record<string, unknown> = {};
  return {
    cookies,
    cookie: vi.fn((n: string, v: unknown, _o: unknown) => { cookies[n] = v; }),
    setHeader: vi.fn(),
    send: vi.fn(),
  } as unknown as Response & { cookies: Record<string, unknown> };
}

function reqWithHost(host: string) {
  return { headers: { 'x-forwarded-host': host } } as unknown as Request;
}

describe('BootstrapController.status', () => {
  beforeEach(() => { delete process.env.BOOTSTRAP_MODE_OVERRIDE; });
  afterEach(() => { delete process.env.BOOTSTRAP_MODE_OVERRIDE; delete process.env.ROOT_CA_PATH; });

  it('waiting: casdoor unreachable, no wg probing, arrival ip', async () => {
    const { controller } = makeController({ probe: vi.fn().mockResolvedValue('unreachable') });
    const res = fakeRes();
    const status = await controller.status(reqWithHost('192.168.2.10'), res);
    expect(status).toMatchObject({ mode: 'waiting', arrival: 'ip', casdoorUp: false, adminClaimed: null });
  });

  it('onboarding: factory login ok, mints the onboarding cookie', async () => {
    const { controller } = makeController({ probe: vi.fn().mockResolvedValue('ok') });
    const res = fakeRes();
    const status = await controller.status(reqWithHost('192.168.2.10'), res);
    expect(status).toMatchObject({ mode: 'onboarding', adminClaimed: false });
    expect(res.cookie).toHaveBeenCalledWith('mp_onboarding', 'signed-token', expect.anything());
  });

  it('ready (claimed): does NOT mint the cookie, queries wg peer state', async () => {
    const peers: WgPeer[] = [
      { clientId: 'a', name: 'phone', enabled: true, latestHandshakeAt: '2026-09-05T10:00:00Z' },
      { clientId: 'b', name: 'lap', enabled: true, latestHandshakeAt: '2026-09-05T09:00:00Z' },
    ];
    const { controller, wgEasy } = makeController({
      probe: vi.fn().mockResolvedValue('rejected'),
      wg: { listClients: vi.fn().mockResolvedValue(peers) },
    });
    const res = fakeRes();
    const status = await controller.status(reqWithHost('libre.pod'), res);
    expect(status).toMatchObject({
      mode: 'ready', arrival: 'domain', adminClaimed: true, peerCount: 2, wgEasyUp: true,
      lastHandshakeAt: '2026-09-05T10:00:00Z',
    });
    expect(res.cookie).not.toHaveBeenCalled();
    expect(wgEasy.listClients).toHaveBeenCalled();
  });

  it('caches the rejected probe (no login storm after claim)', async () => {
    const probe = vi.fn().mockResolvedValue('rejected');
    const { controller } = makeController({ probe });
    await controller.status(reqWithHost('libre.pod'), fakeRes());
    await controller.status(reqWithHost('libre.pod'), fakeRes());
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('BOOTSTRAP_MODE_OVERRIDE forces the mode (test seam)', async () => {
    process.env.BOOTSTRAP_MODE_OVERRIDE = 'onboarding';
    const { controller } = makeController({ probe: vi.fn().mockResolvedValue('rejected') });
    const status = await controller.status(reqWithHost('libre.pod'), fakeRes());
    expect(status.mode).toBe('onboarding');
  });
});

describe('BootstrapController.claim', () => {
  it('takes over, adopts the same password on wg-easy, mints the cookie', async () => {
    const claim = vi.fn().mockResolvedValue(undefined);
    const adoptPassword = vi.fn().mockResolvedValue(undefined);
    const { controller } = makeController({ probe: vi.fn().mockResolvedValue('ok'), claim, wg: { adoptPassword } });
    const res = fakeRes();
    await controller.claim({ password: 'longenough1' }, res);
    expect(claim).toHaveBeenCalledWith({ password: 'longenough1' });
    expect(adoptPassword).toHaveBeenCalledWith('longenough1');
    expect(res.cookie).toHaveBeenCalled();
  });

  it('claim survives a failed password adoption (deferred to first wg call)', async () => {
    const { controller } = makeController({
      probe: vi.fn().mockResolvedValue('ok'),
      claim: vi.fn().mockResolvedValue(undefined),
      wg: { adoptPassword: vi.fn().mockRejectedValue(new Error('no k8s')) },
    });
    const res = fakeRes();
    await expect(controller.claim({ password: 'longenough1' }, res)).resolves.toMatchObject({ ok: true });
  });

  it('rejects weak input before touching casdoor', async () => {
    const { controller, casdoorAdmin } = makeController({});
    await expect(controller.claim({ password: 'short' }, fakeRes())).rejects.toThrow(BadRequestException);
    await expect(controller.claim({ password: 'has space1' }, fakeRes())).rejects.toThrow(BadRequestException);
    expect(casdoorAdmin.claim).not.toHaveBeenCalled();
  });
});

describe('BootstrapController.ca', () => {
  afterEach(() => { delete process.env.ROOT_CA_PATH; });

  it('streams the mounted root CA with download headers', async () => {
    // real temp file — the node:fs namespace is frozen and cannot be spied
    const dir = mkdtempSync(join(tmpdir(), 'root-ca-'));
    const file = join(dir, 'root_ca.crt');
    writeFileSync(file, '-----BEGIN CERTIFICATE-----\n…');
    process.env.ROOT_CA_PATH = file;
    try {
      const { controller } = makeController({});
      const res = fakeRes();
      await controller.ca(res);
      expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/x-x509-ca-cert');
      expect(res.send).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('404s when the CA is not mounted', () => {
    process.env.ROOT_CA_PATH = '/nonexistent/root_ca.crt';
    const { controller } = makeController({});
    // ca() is a sync handler — the NotFoundException fires synchronously
    expect(() => controller.ca(fakeRes())).toThrow(NotFoundException);
  });
});
