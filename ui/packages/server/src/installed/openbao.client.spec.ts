import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { OpenBaoClient, OpenBaoMisconfiguredError, OpenBaoUnavailableError } from './openbao.client';

const ADDR = 'http://openbao.test:8200';

function configOf(env: Record<string, string>): ConfigService {
  return { get: (key: string, fallback?: string) => env[key] ?? fallback } as unknown as ConfigService;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const loginOk = (token = 'client-token', lease = 3600) =>
  json({ auth: { client_token: token, lease_duration: lease } });
const writeOk = () => json({ data: { version: 1 } });
const tokenHeader = (init: RequestInit) => (init.headers as Record<string, string>)['X-Vault-Token'];

describe('OpenBaoClient', () => {
  let fetchMock: MockInstance<typeof fetch>;
  let dir: string;
  let saTokenPath: string;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch');
    dir = mkdtempSync(join(tmpdir(), 'openbao-client-'));
    saTokenPath = join(dir, 'token');
    writeFileSync(saTokenPath, 'sa-jwt\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const k8sClient = (extra: Record<string, string> = {}) =>
    new OpenBaoClient(configOf({ OPENBAO_ADDR: ADDR, OPENBAO_SA_TOKEN_PATH: saTokenPath, ...extra }));
  const staticClient = (extra: Record<string, string> = {}) =>
    new OpenBaoClient(configOf({ OPENBAO_ADDR: ADDR, OPENBAO_TOKEN: 'root', ...extra }));

  it('refuses to write when OPENBAO_ADDR is not set', async () => {
    await expect(new OpenBaoClient(configOf({})).writeAppSettings('demo', { A: '1' })).rejects.toBeInstanceOf(
      OpenBaoMisconfiguredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes the whole entry verbatim with a static token (test seam)', async () => {
    fetchMock.mockResolvedValueOnce(writeOk());
    const data = {
      PLAIN: 'on',
      YAMLISH: 'a: b #c',
      SUBST: '${BASE_DOMAIN}',
      MULTI: 'line1\nline2',
      QUOTED: '"x" \'y\'',
      UNICODE: 'ключ ✓',
    };

    await staticClient({ OPENBAO_ADDR: `${ADDR}/` }).writeAppSettings('demo', data);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ADDR}/v1/secret/data/apps/demo`);
    expect(init.method).toBe('POST');
    expect(tokenHeader(init)).toBe('root');
    expect(JSON.parse(init.body as string)).toEqual({ data });
  });

  it('uses the configured KV mount', async () => {
    fetchMock.mockResolvedValueOnce(writeOk());
    await staticClient({ OPENBAO_KV_MOUNT: 'kv' }).writeAppSettings('demo', { A: '1' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${ADDR}/v1/kv/data/apps/demo`);
  });

  it('logs in with Kubernetes auth and writes with the client token', async () => {
    fetchMock.mockResolvedValueOnce(loginOk('t1')).mockResolvedValueOnce(writeOk());

    await k8sClient().writeAppSettings('demo', { A: '1' });

    const [loginUrl, loginInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(loginUrl).toBe(`${ADDR}/v1/auth/kubernetes/login`);
    expect(JSON.parse(loginInit.body as string)).toEqual({ role: 'marketplace-ui', jwt: 'sa-jwt' });
    expect(tokenHeader(fetchMock.mock.calls[1][1] as RequestInit)).toBe('t1');
  });

  it('honours a custom auth mount and role', async () => {
    fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(writeOk());
    await k8sClient({ OPENBAO_AUTH_MOUNT: 'k8s', OPENBAO_AUTH_ROLE: 'installer' }).writeAppSettings('demo', { A: '1' });
    const [loginUrl, loginInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(loginUrl).toBe(`${ADDR}/v1/auth/k8s/login`);
    expect(JSON.parse(loginInit.body as string).role).toBe('installer');
  });

  it('reuses the client token until shortly before its lease ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    fetchMock
      .mockResolvedValueOnce(loginOk('t1', 120))
      .mockResolvedValueOnce(writeOk())
      .mockResolvedValueOnce(writeOk())
      .mockResolvedValueOnce(loginOk('t2', 120))
      .mockResolvedValueOnce(writeOk());
    const client = k8sClient();

    await client.writeAppSettings('a', { A: '1' }); // login + write
    vi.setSystemTime(new Date('2026-10-05T10:00:59Z'));
    await client.writeAppSettings('b', { B: '1' }); // cached (refresh is due at +60s)
    vi.setSystemTime(new Date('2026-10-05T10:01:01Z'));
    await client.writeAppSettings('c', { C: '1' }); // re-login

    const logins = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/login'));
    expect(logins).toHaveLength(2);
    expect(tokenHeader(fetchMock.mock.calls[4][1] as RequestInit)).toBe('t2');
  });

  it('logs in again once when a cached token is rejected (403)', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk('old'))
      .mockResolvedValueOnce(json({ errors: ['permission denied'] }, 403))
      .mockResolvedValueOnce(loginOk('new'))
      .mockResolvedValueOnce(writeOk());

    await k8sClient().writeAppSettings('demo', { A: '1' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(tokenHeader(fetchMock.mock.calls[3][1] as RequestInit)).toBe('new');
  });

  it('gives up after one re-login when access stays denied', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk('old'))
      .mockResolvedValueOnce(json({ errors: ['permission denied'] }, 403))
      .mockResolvedValueOnce(loginOk('new'))
      .mockResolvedValueOnce(json({ errors: ['permission denied'] }, 403));

    const err = await k8sClient()
      .writeAppSettings('demo', { A: '1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenBaoMisconfiguredError);
    expect((err as Error).message).toMatch(/HTTP 403/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([400, 404])('reports a write refused with HTTP %i (wrong mount, KV v1, cas_required) as misconfigured', async (status) => {
    fetchMock.mockResolvedValueOnce(json({ errors: ['no handler for route'] }, status));
    await expect(staticClient().writeAppSettings('demo', { A: '1' })).rejects.toBeInstanceOf(OpenBaoMisconfiguredError);
  });

  it.each([429, 500])('reports HTTP %i as unavailable, so the user can retry', async (status) => {
    fetchMock.mockResolvedValueOnce(json({ errors: ['busy'] }, status));
    await expect(staticClient().writeAppSettings('demo', { A: '1' })).rejects.toBeInstanceOf(OpenBaoUnavailableError);
  });

  it('reports a sealed OpenBao (503) as unavailable', async () => {
    fetchMock.mockResolvedValueOnce(json({ errors: ['Vault is sealed'] }, 503));
    await expect(staticClient().writeAppSettings('demo', { A: '1' })).rejects.toBeInstanceOf(OpenBaoUnavailableError);
  });

  it('reports an unreachable OpenBao as unavailable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(staticClient().writeAppSettings('demo', { A: '1' })).rejects.toThrow(/unreachable/);
  });

  it('reports a login refused by the auth role as misconfigured', async () => {
    fetchMock.mockResolvedValueOnce(json({ errors: ['invalid role'] }, 400));
    const err = await k8sClient()
      .writeAppSettings('demo', { A: '1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenBaoMisconfiguredError);
    expect((err as Error).message).toMatch(/login failed: HTTP 400/);
  });

  it('reports a login hitting a sealed OpenBao as unavailable', async () => {
    fetchMock.mockResolvedValueOnce(json({ errors: ['Vault is sealed'] }, 503));
    await expect(k8sClient().writeAppSettings('demo', { A: '1' })).rejects.toBeInstanceOf(OpenBaoUnavailableError);
  });

  it('reports a missing ServiceAccount token as misconfigured', async () => {
    const client = k8sClient({ OPENBAO_SA_TOKEN_PATH: join(dir, 'missing') });
    await expect(client.writeAppSettings('demo', { A: '1' })).rejects.toBeInstanceOf(OpenBaoMisconfiguredError);
    await expect(client.writeAppSettings('demo', { A: '1' })).rejects.toThrow(/ServiceAccount token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives up on a hung OpenBao instead of holding the install forever', async () => {
    // A server that accepts the connection but never answers: only the abort ends it.
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const pending = staticClient().writeAppSettings('demo', { A: '1' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    await expect(pending).rejects.toBeInstanceOf(OpenBaoUnavailableError);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it('never puts the written values into its errors', async () => {
    fetchMock.mockResolvedValueOnce(json({ errors: ['internal error'] }, 500));
    const err = await staticClient()
      .writeAppSettings('demo', { TOKEN: 's3cr3t-value' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenBaoUnavailableError);
    expect((err as Error).message).toContain('HTTP 500');
    expect((err as Error).message).not.toContain('s3cr3t-value');
  });
});
