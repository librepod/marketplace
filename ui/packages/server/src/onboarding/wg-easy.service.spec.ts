import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WgEasyService } from './wg-easy.service';
import type { DeviceAdminStore } from './device-admin.store';

function makeService(store: Partial<DeviceAdminStore>) {
  return new WgEasyService(store as DeviceAdminStore);
}

function ok(body: unknown, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

/** Real temp file standing in for the mounted factory-password Secret — the
 * node:fs namespace is frozen, so readFileSync cannot be spied. */
function factoryFile(content = 'ChangeMeOnFirstLogin!\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-easy-factory-'));
  const file = join(dir, 'INIT_PASSWORD');
  writeFileSync(file, content);
  return file;
}

describe('WgEasyService', () => {
  let factoryPath: string;

  beforeEach(() => {
    process.env.WGEASY_BASE_URL = 'http://wg-easy.test';
    factoryPath = factoryFile();
    process.env.WGEASY_PASSWORD_FILE = factoryPath;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WGEASY_PASSWORD_FILE;
    rmSync(join(factoryPath, '..'), { recursive: true, force: true });
  });

  it('uses the persisted password when it still authenticates', async () => {
    const load = vi.fn().mockResolvedValue('rotated-pw');
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(ok([]));
    const svc = makeService({ load });
    expect(await svc.ensurePassword()).toBe('rotated-pw');
    expect(fetchMock.mock.calls[0][0]).toBe('http://wg-easy.test/api/client');
  });

  it('adoptPassword: persists FIRST, then rotates the factory password to the user-chosen one', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn().mockResolvedValue(undefined);
    const calls: Array<{ url: string; auth?: string; body?: string }> = [];
    const chosenB64 = Buffer.from('admin:chosen-pw1').toString('base64');
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), auth: headers['authorization'], body: init?.body == null ? undefined : String(init.body) });
      const u = String(url);
      if (u.endsWith('/api/me/password')) return ok({ success: true });
      // fresh cluster: the chosen password does not authenticate on wg-easy
      // until the rotation below applies it — only the factory credential does
      if ((headers['authorization'] ?? '').includes(chosenB64)) {
        return new Response('', { status: 401 });
      }
      return ok([]); // /api/client probe/list
    });
    const svc = makeService({ load, save });
    await svc.adoptPassword('chosen-pw1');
    expect(save).toHaveBeenCalledWith('chosen-pw1');
    const rotate = calls.find((c) => c.url.endsWith('/api/me/password'))!;
    // rotated FROM the factory credential TO the chosen password
    expect(rotate.auth).toContain(Buffer.from('admin:ChangeMeOnFirstLogin!').toString('base64'));
    expect(JSON.parse(rotate.body!)).toMatchObject({
      currentPassword: 'ChangeMeOnFirstLogin!',
      newPassword: 'chosen-pw1',
    });
  });

  it('adoptPassword survives a wg-easy outage: persisted, rotation deferred', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = makeService({ load: vi.fn().mockResolvedValue(undefined), save });
    await expect(svc.adoptPassword('chosen-pw1')).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledWith('chosen-pw1');
  });

  it('ensurePassword lazily rotates to the persisted value (wg was down at claim)', async () => {
    const rotations: string[] = [];
    const chosenB64 = Buffer.from('admin:chosen-pw1').toString('base64');
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (u.endsWith('/api/me/password')) {
        rotations.push(String(init!.body));
        return ok({ success: true });
      }
      // the chosen password is NOT yet active on wg-easy — only factory authenticates
      if ((headers['authorization'] ?? '').includes(chosenB64)) {
        return new Response('', { status: 401 });
      }
      return ok([]);
    });
    const svc = makeService({ load: vi.fn().mockResolvedValue('chosen-pw1'), save: vi.fn() });
    expect(await svc.ensurePassword()).toBe('chosen-pw1');
    expect(rotations).toHaveLength(1);
    expect(JSON.parse(rotations[0]!)).toMatchObject({
      currentPassword: 'ChangeMeOnFirstLogin!',
      newPassword: 'chosen-pw1',
    });
  });

  it('throws when no credential works (already rotated elsewhere + factory dead)', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    await expect(makeService({ load }).ensurePassword()).rejects.toThrow(ServiceUnavailableException);
  });

  it('createClient posts {name, expiresAt: null} and returns clientId', async () => {
    const svc = makeService({ load: vi.fn().mockResolvedValue('pw') });
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(ok([])) // probe
      .mockResolvedValueOnce(ok({ success: true, clientId: 'c1' }));
    expect(await svc.createClient('phone')).toEqual({ clientId: 'c1' });
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe('http://wg-easy.test/api/client');
    expect(JSON.parse(String(init!.body))).toEqual({ name: 'phone', expiresAt: null });
  });

  it('listClients maps peers with latestHandshakeAt', async () => {
    const svc = makeService({ load: vi.fn().mockResolvedValue('pw') });
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([
        { clientId: 'a', name: 'phone', enabled: true, latestHandshakeAt: '2026-09-05T10:00:00Z' },
        { clientId: 'b', name: 'laptop', enabled: false },
      ]));
    const peers = await svc.listClients();
    expect(peers[1]).toMatchObject({ clientId: 'b', latestHandshakeAt: null });
  });

  it('clientConfiguration / clientQrSvg passthrough as text', async () => {
    const svc = makeService({ load: vi.fn().mockResolvedValue('pw') });
    // the password is cached after the first probe, so only three calls happen
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok('[Interface]\n…', 200))
      .mockResolvedValueOnce(ok('<svg/>', 200));
    expect(await svc.clientConfiguration('c1')).toContain('[Interface]');
    expect(await svc.clientQrSvg('c1')).toContain('<svg');
  });
});
