import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { CasdoorAdminService } from './casdoor-admin.service';

function jsonRes(body: unknown, opts: { setCookie?: string[]; status?: number } = {}) {
  const headers = new Headers();
  (opts.setCookie ?? []).forEach((c) => headers.append('set-cookie', c));
  return new Response(JSON.stringify(body), { status: opts.status ?? 200, headers });
}

describe('CasdoorAdminService', () => {
  beforeEach(() => {
    process.env.CASDOOR_BASE_URL = 'http://casdoor.test';
    process.env.CASDOOR_ADMIN_DEFAULT_PASSWORD = '123';
    process.env.BASE_DOMAIN = 'libre.pod';
  });
  afterEach(() => vi.spyOn(global, 'fetch').mockRestore());

  it('probeFactoryLogin: ok when the factory password still works', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ status: 'ok' }));
    expect(await new CasdoorAdminService().probeFactoryLogin()).toBe('ok');
  });

  it('probeFactoryLogin: rejected on wrong password', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonRes({ status: 'error', msg: 'password incorrect' }),
    );
    expect(await new CasdoorAdminService().probeFactoryLogin()).toBe('rejected');
  });

  it('probeFactoryLogin: unreachable on network error / empty base URL', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await new CasdoorAdminService().probeFactoryLogin()).toBe('unreachable');
    delete process.env.CASDOOR_BASE_URL;
    expect(await new CasdoorAdminService().probeFactoryLogin()).toBe('unreachable');
  });

  it('probeFactoryLogin: a degraded casdoor (5xx / HTML) is unreachable, NOT claimed', async () => {
    // A half-booted casdoor returning 500 or an error page must never latch
    // "rejected" (claimed) — that would freeze the wizard out of Claim.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonRes({ status: 'error', msg: 'db not ready' }, { status: 500 }),
    );
    expect(await new CasdoorAdminService().probeFactoryLogin()).toBe('unreachable');
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );
    expect(await new CasdoorAdminService().probeFactoryLogin()).toBe('unreachable');
  });

  it('claim: ensures org, creates the fixed owner, then closes the factory window', async () => {
    const calls: Array<{ url: string; body?: string; headers: Record<string, string> }> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      calls.push({
        url: String(url),
        // URLSearchParams bodies (set-password) are recorded serialized
        body: init?.body == null ? undefined : String(init.body),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const u = String(url);
      if (u.endsWith('/api/login')) return jsonRes({ status: 'ok' }, { setCookie: ['casdoor_session=abc'] });
      if (u.includes('/api/get-organization')) return jsonRes({ status: 'ok', data: null });
      if (u.includes('/api/get-user')) return jsonRes({ status: 'ok', data: null });
      return jsonRes({ status: 'ok' });
    });
    await new CasdoorAdminService().claim({ password: 'hunter2hunter2' });

    const urls = calls.map((c) => c.url.replace('http://casdoor.test', ''));
    expect(urls).toEqual([
      '/api/login',
      '/api/get-organization?id=librepod',
      '/api/add-organization',
      '/api/get-user?id=librepod/admin',
      '/api/add-user',
      '/api/set-password',
    ]);
    // fixed-identity owner created in the platform org, factory window closed last
    const addUser = JSON.parse(calls[4]!.body!);
    expect(addUser).toMatchObject({
      owner: 'librepod',
      name: 'admin',
      email: 'admin@libre.pod',
      isAdmin: true,
      password: 'hunter2hunter2',
    });
    const setPassword = new URLSearchParams(calls[5]!.body!);
    expect(setPassword.get('userOwner')).toBe('built-in');
    expect(setPassword.get('userName')).toBe('admin');
    expect(setPassword.get('oldPassword')).toBe('123');
    expect(setPassword.get('newPassword')).not.toBe('123');
    // every post-login call replays the session cookie
    expect(calls[5]!.headers['cookie'] ?? (calls[5]!.headers as any).cookie).toContain('casdoor_session=abc');
  });

  it('claim: skips existing org/user (idempotent retry)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/login')) return jsonRes({ status: 'ok' }, { setCookie: ['casdoor_session=abc'] });
      if (u.includes('/api/get-organization')) return jsonRes({ status: 'ok', data: { name: 'librepod' } });
      if (u.includes('/api/get-user')) return jsonRes({ status: 'ok', data: { name: 'admin' } });
      return jsonRes({ status: 'ok' });
    });
    await new CasdoorAdminService().claim({ password: 'hunter2hunter2' });
    // only login + the two existence GETs + set-password
    expect((global.fetch as any).mock.calls.length).toBe(4);
  });

  it('claim: ConflictException when the factory credential is already dead', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ status: 'error', msg: 'wrong password' }));
    await expect(new CasdoorAdminService().claim({ password: 'yyyyyyyy' })).rejects.toThrow(ConflictException);
  });

  it('claim: rejects passwords casdoor would refuse (spaces)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/login')) return jsonRes({ status: 'ok' }, { setCookie: ['a=b'] });
      if (u.includes('/api/get-organization')) return jsonRes({ status: 'ok', data: {} });
      if (u.includes('/api/get-user')) return jsonRes({ status: 'ok', data: {} });
      // set-password: space in newPassword
      return jsonRes({ status: 'error', msg: 'New password cannot contain blank space.' });
    });
    await expect(new CasdoorAdminService().claim({ password: 'valid password' })).rejects.toThrow('set-password failed');
  });
});
