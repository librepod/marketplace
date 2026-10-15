import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { CasdoorAdminService, type CasdoorSession } from './casdoor-admin.service';

function jsonRes(body: unknown, opts: { status?: number; setCookie?: string[] } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  (opts.setCookie ?? []).forEach((c) => headers.append('set-cookie', c));
  return new Response(JSON.stringify(body), { status: opts.status ?? 200, headers });
}

interface Call { url: string; method: string; body?: string; cookie?: string }
function recordFetch(answer: (url: string, body?: string) => Response) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const body = init?.body == null ? undefined : String(init.body);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url).replace('http://casdoor.test', ''), method: init?.method ?? 'GET', body, cookie: headers.cookie });
    return answer(String(url), body);
  });
  return calls;
}

const session: CasdoorSession = { cookie: 'casdoor_session_id=abc', password: 'admin-password-12' };

describe('CasdoorAdminService', () => {
  beforeEach(() => {
    process.env.CASDOOR_BASE_URL = 'http://casdoor.test';
    process.env.CASDOOR_ORG_NAME = 'librepod';
    process.env.BASE_DOMAIN = 'libre.pod';
    delete process.env.CASDOOR_ADMIN_DEFAULT_PASSWORD;
  });
  afterEach(() => vi.restoreAllMocks());

  it('factoryPassword defaults to Casdoor\'s "123" and follows CASDOOR_ADMIN_DEFAULT_PASSWORD', () => {
    expect(new CasdoorAdminService().factoryPassword).toBe('123');
    process.env.CASDOOR_ADMIN_DEFAULT_PASSWORD = 'factory';
    expect(new CasdoorAdminService().factoryPassword).toBe('factory');
  });

  describe('reachable', () => {
    it('is true when OIDC discovery answers JSON', async () => {
      const calls = recordFetch(() => jsonRes({ issuer: 'https://id.libre.pod' }));
      expect(await new CasdoorAdminService().reachable()).toBe(true);
      expect(calls[0].url).toBe('/.well-known/openid-configuration');
    });

    it('is false on a network error, an error page, or no base URL', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
      expect(await new CasdoorAdminService().reachable()).toBe(false);
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));
      expect(await new CasdoorAdminService().reachable()).toBe(false);
      delete process.env.CASDOOR_BASE_URL;
      expect(await new CasdoorAdminService().reachable()).toBe(false);
    });
  });

  describe('signIn', () => {
    it('tries the candidates in order, skipping empty and repeated ones, and keeps only name=value cookies', async () => {
      const calls = recordFetch((_url, body) =>
        JSON.parse(body!).password === 'new-password-12'
          ? jsonRes({ status: 'ok' }, { setCookie: ['casdoor_session_id=abc; Path=/; HttpOnly'] })
          : jsonRes({ status: 'error', msg: 'password or code is incorrect' }),
      );
      const result = await new CasdoorAdminService().signIn(['', '123', '123', 'new-password-12']);
      expect(result).toEqual({ cookie: 'casdoor_session_id=abc', password: 'new-password-12' });
      expect(calls.map((c) => JSON.parse(c.body!).password)).toEqual(['123', 'new-password-12']);
      expect(JSON.parse(calls[0].body!)).toMatchObject({
        type: 'login', application: 'app-built-in', organization: 'built-in', username: 'admin',
      });
    });

    it('is null when Casdoor rejects every candidate', async () => {
      recordFetch(() => jsonRes({ status: 'error', msg: 'password or code is incorrect' }));
      expect(await new CasdoorAdminService().signIn(['a-password-123', 'b-password-123'])).toBeNull();
    });

    it('a down or erroring Casdoor is a 503 — never "wrong password"', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(new CasdoorAdminService().signIn(['123'])).rejects.toThrow(ServiceUnavailableException);
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonRes({ status: 'error', msg: 'db' }, { status: 500 }));
      await expect(new CasdoorAdminService().signIn(['123'])).rejects.toThrow(ServiceUnavailableException);
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));
      await expect(new CasdoorAdminService().signIn(['123'])).rejects.toThrow(ServiceUnavailableException);
    });
  });

  it('setAdminPassword posts the form set-password accepts, with the session cookie', async () => {
    const calls = recordFetch(() => jsonRes({ status: 'ok' }));
    await new CasdoorAdminService().setAdminPassword(session, 'new-password-12');
    expect(calls[0]).toMatchObject({ url: '/api/set-password', method: 'POST', cookie: 'casdoor_session_id=abc' });
    const form = new URLSearchParams(calls[0].body);
    expect(Object.fromEntries(form)).toEqual({
      userOwner: 'built-in', userName: 'admin', oldPassword: 'admin-password-12', newPassword: 'new-password-12',
    });
  });

  describe('ensureOrganization', () => {
    it('does nothing when the platform org exists (looked up as admin/<org>)', async () => {
      const calls = recordFetch(() => jsonRes({ status: 'ok', data: { name: 'librepod' } }));
      await new CasdoorAdminService().ensureOrganization(session);
      expect(calls.map((c) => c.url)).toEqual(['/api/get-organization?id=admin/librepod']);
    });

    it('creates it when missing, with a password type — an empty one fails every sign-in', async () => {
      const calls = recordFetch((url) =>
        url.includes('get-organization') ? jsonRes({ status: 'ok', data: null }) : jsonRes({ status: 'ok' }),
      );
      await new CasdoorAdminService().ensureOrganization(session);
      expect(calls[1].url).toBe('/api/add-organization');
      // Casdoor 3.106's add-organization leaves passwordType empty; its users then can't
      // sign in ("unsupported password type"). bcrypt is Casdoor's own UI default.
      expect(JSON.parse(calls[1].body!)).toMatchObject({ owner: 'admin', name: 'librepod', passwordType: 'bcrypt' });
    });

    it('an error answer is surfaced, not mistaken for "missing"', async () => {
      const calls = recordFetch(() => jsonRes({ status: 'error', msg: 'wrong id format' }));
      await expect(new CasdoorAdminService().ensureOrganization(session)).rejects.toThrow(BadGatewayException);
      expect(calls).toHaveLength(1);
    });
  });

  describe('platform-org users', () => {
    it('getUser returns the user or null', async () => {
      const calls = recordFetch((url) =>
        url.endsWith('/alex') ? jsonRes({ status: 'ok', data: { name: 'alex' } }) : jsonRes({ status: 'ok', data: null }),
      );
      const svc = new CasdoorAdminService();
      expect(await svc.getUser(session, 'alex')).toMatchObject({ name: 'alex' });
      expect(await svc.getUser(session, 'bob')).toBeNull();
      expect(calls[0].url).toBe('/api/get-user?id=librepod/alex');
    });

    it('addUser creates <name>@<base-domain> as an admin of the platform org', async () => {
      const calls = recordFetch(() => jsonRes({ status: 'ok' }));
      await new CasdoorAdminService().addUser(session, 'alex', 'personal-pass-12');
      expect(calls[0].url).toBe('/api/add-user');
      expect(JSON.parse(calls[0].body!)).toMatchObject({
        owner: 'librepod', name: 'alex', email: 'alex@libre.pod', password: 'personal-pass-12', isAdmin: true,
      });
    });

    it('setUserPassword needs no old password (the caller is Casdoor\'s admin)', async () => {
      const calls = recordFetch(() => jsonRes({ status: 'ok' }));
      await new CasdoorAdminService().setUserPassword(session, 'alex', 'brand-new-pass-12');
      expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
        userOwner: 'librepod', userName: 'alex', oldPassword: '', newPassword: 'brand-new-pass-12',
      });
    });

    it("a refused call carries Casdoor's reason", async () => {
      recordFetch(() => jsonRes({ status: 'error', msg: 'the user already exists' }));
      await expect(new CasdoorAdminService().addUser(session, 'alex', 'personal-pass-12')).rejects.toThrow(
        /Casdoor refused \/api\/add-user: the user already exists/,
      );
    });
  });
});
