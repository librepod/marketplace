import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { WgEasyService } from './wg-easy.service';
import type { OpenBaoClient } from '../installed/openbao.client';

const PASSWORD = 'owner-password-12';

/** `entry` is what OpenBao apps/wg-easy holds — or the error reading it throws. */
function makeService(entry: Record<string, string> | null | Error = { INIT_PASSWORD: PASSWORD }) {
  const readAppSettings =
    entry instanceof Error ? vi.fn().mockRejectedValue(entry) : vi.fn().mockResolvedValue(entry);
  const svc = new WgEasyService({ readAppSettings } as unknown as OpenBaoClient);
  return { svc, readAppSettings };
}

function ok(body: unknown, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

const basic = (password: string) => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
const authOf = (init: RequestInit | undefined) => (init?.headers as Record<string, string>).authorization;

describe('WgEasyService', () => {
  beforeEach(() => {
    process.env.WGEASY_BASE_URL = 'http://wg-easy.test';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WGEASY_BASE_URL;
  });

  it("authenticates with wg-easy's install answer from OpenBao apps/wg-easy — one call, no setup, no rotation", async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(ok([]));
    const { svc, readAppSettings } = makeService();
    await svc.listClients();
    expect(readAppSettings).toHaveBeenCalledWith('wg-easy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://wg-easy.test/api/client');
    expect(authOf(init)).toBe(basic(PASSWORD));
  });

  it('re-reads the answer on every call, so a reinstall with a new password is picked up at once', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => ok([]));
    const { svc, readAppSettings } = makeService();
    await svc.listClients();
    readAppSettings.mockResolvedValue({ INIT_PASSWORD: 'second-password-1' });
    await svc.listClients();
    expect(authOf(fetchMock.mock.calls[1]![1])).toBe(basic('second-password-1'));
  });

  it('503s without calling wg-easy when the entry or its password is missing, or OpenBao fails', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    const entries: Array<Record<string, string> | null | Error> = [null, {}, new Error('sealed')];
    for (const entry of entries) {
      await expect(makeService(entry).svc.listClients()).rejects.toThrow(ServiceUnavailableException);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 401 says the admin password was rejected, distinct from unreachable', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }));
    const { svc } = makeService();
    const err = await svc.listClients().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).toContain('rejected its admin password');
  });

  it('503s when wg-easy rejects the credential or is unreachable', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { svc } = makeService();
    await expect(svc.listClients()).rejects.toThrow(ServiceUnavailableException);
    await expect(svc.listClients()).rejects.toThrow(ServiceUnavailableException);
  });

  it('createClient posts {name, expiresAt: null} and returns the clientId', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(ok({ success: true, clientId: 'c1' }));
    expect(await makeService().svc.createClient('phone')).toEqual({ clientId: 'c1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://wg-easy.test/api/client');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(String(init!.body))).toEqual({ name: 'phone', expiresAt: null });
  });

  it('listClients maps peers, defaulting a missing handshake to null', async () => {
    // wg-easy v15's GET /api/client spreads the DB row: the key is the integer
    // `id` (only POST answers with `clientId`).
    vi.spyOn(global, 'fetch').mockResolvedValue(
      ok([
        { id: 1, name: 'phone', enabled: true, latestHandshakeAt: '2026-09-05T10:00:00Z' },
        { id: 2, name: 'laptop', enabled: false, latestHandshakeAt: null },
      ]),
    );
    const peers = await makeService().svc.listClients();
    expect(peers[0]).toMatchObject({ clientId: '1', latestHandshakeAt: '2026-09-05T10:00:00Z' });
    expect(peers[1]).toMatchObject({ clientId: '2', enabled: false, latestHandshakeAt: null });
  });

  it('clientConfiguration / clientQrSvg pass the text through', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(ok('[Interface]\n…'))
      .mockResolvedValueOnce(ok('<svg/>'));
    const { svc } = makeService();
    expect(await svc.clientConfiguration('c1')).toContain('[Interface]');
    expect(await svc.clientQrSvg('c1')).toContain('<svg');
  });
});
