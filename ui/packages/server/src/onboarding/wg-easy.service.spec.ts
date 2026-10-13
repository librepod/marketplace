import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { WgEasyService } from './wg-easy.service';
import type { DeviceAdminStore } from './device-admin.store';
import type { OpenBaoClient } from '../installed/openbao.client';

function makeService(store: Partial<DeviceAdminStore>, bao: Partial<OpenBaoClient> = {}) {
  const storeMock = { load: vi.fn().mockResolvedValue({}), save: vi.fn(), ...store };
  const baoMock = {
    readAppSettings: vi.fn().mockResolvedValue(null),
    writeAppSettings: vi.fn(),
    ...bao,
  };
  const svc = new WgEasyService(
    storeMock as unknown as DeviceAdminStore,
    baoMock as unknown as OpenBaoClient,
  );
  return { svc, storeMock, baoMock };
}

function ok(body: unknown, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

/** A fetch mock routed by URL path, so order-based assertions don't break
 * when the service probes before it acts. */
function routeFetch(routes: Record<string, { status: number; body?: unknown } | ((...a: unknown[]) => { status: number; body?: unknown })>) {
  return vi.spyOn(global, 'fetch').mockImplementation(((url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const route = routes[path];
    if (!route) return Promise.resolve(ok({}, 404));
    const r = typeof route === 'function' ? route(init) : route;
    return Promise.resolve(ok(r.body ?? { success: true }, r.status));
  }) as unknown as typeof fetch);
}

/** Basic-auth credentials a request actually carried (for 401-ing wrong
 * passwords pre-rotation). */
function basicAuth(init?: RequestInit): string {
  const h = (init?.headers as Record<string, string>)?.authorization ?? '';
  return atob(h.slice('Basic '.length));
}

describe('WgEasyService', () => {
  beforeEach(() => {
    process.env.WGEASY_BASE_URL = 'http://wg-easy.test';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uses the persisted password when it still authenticates', async () => {
    const load = vi.fn().mockResolvedValue({ password: 'rotated-pw' });
    const fetchMock = routeFetch({ '/api/client': { status: 200, body: [] } });
    const { svc } = makeService({ load });
    expect(await svc.ensurePassword()).toBe('rotated-pw');
    expect(fetchMock.mock.calls[0][0]).toBe('http://wg-easy.test/api/client');
    expect(basicAuth(fetchMock.mock.calls[0][1])).toBe('admin:rotated-pw');
  });

  it('fresh instance: completes first-boot setup with the chosen password and host, no rotation', async () => {
    // wanted password does NOT auth (no user exists yet — setup incomplete)
    const fetchMock = routeFetch({
      '/api/client': { status: 401 },
      '/api/setup/2': { status: 200 },
      '/api/setup/4': { status: 200 },
    });
    const { svc, baoMock } = makeService(
      { load: vi.fn().mockResolvedValue({ password: 'longenough1' }) },
      { readAppSettings: vi.fn().mockResolvedValue({ INIT_PASSWORD: 'boot-ticket' }) },
    );
    await expect(svc.ensurePassword('longenough1', '192.168.1.50')).resolves.toBe('longenough1');
    const setup2 = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/setup/2'))!;
    expect(JSON.parse(String(setup2[1]!.body))).toEqual({
      username: 'admin',
      password: 'longenough1',
      confirmPassword: 'longenough1',
    });
    const setup4 = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/setup/4'))!;
    expect(JSON.parse(String(setup4[1]!.body))).toEqual({ host: '192.168.1.50', port: 51820 });
    // no rotation call was made
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/api/me/password'))).toBe(false);
    // the adopted credential + host were written back to the OpenBao entry
    expect(baoMock.writeAppSettings).toHaveBeenCalledWith('wg-easy', {
      INIT_PASSWORD: 'longenough1',
      INIT_HOST: '192.168.1.50',
    });
  });

  it('setup already completed (migrated install): rotates from the OpenBao entry value', async () => {
    // setup/2 refuses (setup done); the factory value from OpenBao authenticates
    const fetchMock = routeFetch({
      '/api/client': (init) =>
        basicAuth(init) === 'admin:ChangeMeOnFirstLogin!' ? { status: 200, body: [] } : { status: 401 },
      '/api/setup/2': { status: 400 },
      '/api/me/password': { status: 200 },
    });
    const save = vi.fn();
    const { svc } = makeService(
      { load: vi.fn().mockResolvedValue({ password: 'longenough1' }), save },
      { readAppSettings: vi.fn().mockResolvedValue({ INIT_PASSWORD: 'ChangeMeOnFirstLogin!' }) },
    );
    await expect(svc.ensurePassword('longenough1')).resolves.toBe('longenough1');
    expect(save).toHaveBeenCalledWith('longenough1', undefined); // persist before rotating
    const rotation = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/me/password'))!;
    expect(JSON.parse(String(rotation[1]!.body))).toEqual({
      currentPassword: 'ChangeMeOnFirstLogin!',
      newPassword: 'longenough1',
    });
  });

  it('lazy retry after a claim-time outage: completes setup from the persisted password + host', async () => {
    // claim-time outage: adoptPassword's ensurePassword threw (unreachable);
    // the later wg call retries with the persisted pair.
    const fetchMock = routeFetch({
      // no user exists yet — Basic auth cannot succeed until setup completes
      '/api/client': { status: 401 },
      '/api/setup/2': { status: 200 },
      '/api/setup/4': { status: 200 },
    });
    const { svc } = makeService({
      load: vi.fn().mockResolvedValue({ password: 'longenough1', wgHost: '192.168.1.50' }),
    });
    await expect(svc.ensurePassword()).resolves.toBe('longenough1');
    const setup4 = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/setup/4'))!;
    expect(JSON.parse(String(setup4[1]!.body))).toEqual({ host: '192.168.1.50', port: 51820 });
  });

  it('adoptPassword: persists FIRST (password + host), then adopts, then writes back', async () => {
    routeFetch({
      '/api/client': { status: 401 },
      '/api/setup/2': { status: 200 },
      '/api/setup/4': { status: 200 },
    });
    const save = vi.fn();
    const { svc, baoMock } = makeService(
      { save, load: vi.fn().mockResolvedValue({ password: 'longenough1', wgHost: '192.168.1.50' }) },
      { readAppSettings: vi.fn().mockResolvedValue({ INIT_PASSWORD: 'boot-ticket' }) },
    );
    await svc.adoptPassword('longenough1', '192.168.1.50');
    expect(save.mock.calls[0]).toEqual(['longenough1', '192.168.1.50']);
    expect(baoMock.writeAppSettings).toHaveBeenCalledWith('wg-easy', {
      INIT_PASSWORD: 'longenough1',
      INIT_HOST: '192.168.1.50',
    });
  });

  it('rotation also writes back, merging into the existing entry (preserves foreign keys)', async () => {
    routeFetch({
      '/api/client': (init) =>
        basicAuth(init) === 'admin:old' ? { status: 200, body: [] } : { status: 401 },
      '/api/setup/2': { status: 400 },
      '/api/me/password': { status: 200 },
    });
    const { svc, baoMock } = makeService(
      { load: vi.fn().mockResolvedValue({ password: 'longenough1' }) },
      { readAppSettings: vi.fn().mockResolvedValue({ INIT_PASSWORD: 'old', OTHER: 'keep-me' }) },
    );
    await svc.ensurePassword('longenough1');
    expect(baoMock.writeAppSettings).toHaveBeenCalledWith('wg-easy', {
      INIT_PASSWORD: 'longenough1',
      OTHER: 'keep-me',
    });
  });

  it('adoptPassword defers (no throw) when wg-easy is unreachable, but still persists', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const save = vi.fn();
    const { svc } = makeService({ save, load: vi.fn().mockResolvedValue({}) });
    await expect(svc.adoptPassword('longenough1', '192.168.1.50')).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledWith('longenough1', '192.168.1.50');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('throws when nothing works: no auth, no setup (no host), no factory', async () => {
    routeFetch({
      '/api/client': { status: 401 },
      '/api/me/password': { status: 401 },
    });
    const { svc } = makeService(
      // persisted password but NO wgHost: setup path unavailable; OpenBao
      // entry absent: no rotation source either
      { load: vi.fn().mockResolvedValue({ password: 'longenough1' }) },
      { readAppSettings: vi.fn().mockResolvedValue(null) },
    );
    await expect(svc.ensurePassword('longenough1')).rejects.toThrow(ServiceUnavailableException);
  });

  it('openbao read failure degrades to no factory credential (rotation path only)', async () => {
    routeFetch({
      '/api/client': { status: 401 },
      '/api/setup/2': { status: 400 },
    });
    const { svc } = makeService(
      { load: vi.fn().mockResolvedValue({ password: 'longenough1', wgHost: '192.168.1.50' }) },
      { readAppSettings: vi.fn().mockRejectedValue(new Error('openbao down')) },
    );
    await expect(svc.ensurePassword('longenough1', '192.168.1.50')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('createClient/listClients ride the working credential', async () => {
    const fetchMock = routeFetch({
      '/api/client': { status: 200, body: [] },
    });
    const { svc } = makeService({ load: vi.fn().mockResolvedValue({ password: 'rotated-pw' }) });
    expect(await svc.listClients()).toEqual([]);
    const created = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(created).toBeUndefined(); // no POST happened — only the GET list
  });
});
