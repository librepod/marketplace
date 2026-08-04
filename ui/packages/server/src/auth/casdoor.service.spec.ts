import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CasdoorService } from './casdoor.service';

describe('CasdoorService', () => {
  beforeEach(() => {
    process.env.CASDOOR_ENDPOINT = 'https://id.example.com';
    process.env.CASDOOR_CLIENT_ID = 'marketplace-ui';
    process.env.CASDOOR_CLIENT_SECRET = 'secret';
    process.env.CASDOOR_ORG_NAME = 'librepod';
    process.env.CASDOOR_APP_NAME = 'marketplace-ui';
  });

  it('builds the authorize URL with the dynamic host redirect', () => {
    const svc = new CasdoorService();
    const url = new URL(svc.getAuthorizeUrl('marketplace.example.com', 'xyz'));
    expect(url.origin + url.pathname).toBe('https://id.example.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('marketplace-ui');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://marketplace.example.com/api/auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('state')).toBe('xyz');
  });

  it('exchanges a code and returns identity from userinfo', async () => {
    const svc = new CasdoorService();
    // Stub the SDK exchange + the userinfo fetch.
    vi.spyOn(svc as any, 'getAccessToken').mockResolvedValue('access-token');
    vi.spyOn(svc as any, 'fetchUserInfo').mockResolvedValue({
      sub: 'sub-1',
      preferred_username: 'alice',
      name: 'Alice',
      email: 'alice@librepod',
    });
    const identity = await svc.exchangeCode('the-code', 'marketplace.example.com');
    expect(identity).toEqual({ sub: 'sub-1', name: 'alice', email: 'alice@librepod' });
  });

  it('falls back to a direct token POST when the SDK exchange fails', async () => {
    const svc = new CasdoorService();
    vi.spyOn((svc as any).sdk, 'getAuthToken').mockRejectedValue(new Error('boom'));
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 }));
    const token = await (svc as any).getAccessToken('code-x', 'https://host/cb');
    expect(token).toBe('tok-123');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/login/oauth/access_token');
    expect((init as RequestInit).method).toBe('POST');
    fetchMock.mockRestore();
  });

  it('directTokenPost throws on a non-OK token response', async () => {
    const svc = new CasdoorService();
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 400 }));
    await expect((svc as any).directTokenPost('code-x', 'https://host/cb')).rejects.toThrow(
      'token exchange failed: 400',
    );
    fetchMock.mockRestore();
  });

  it('directTokenPost throws when access_token is missing', async () => {
    const svc = new CasdoorService();
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await expect((svc as any).directTokenPost('code-x', 'https://host/cb')).rejects.toThrow(
      'missing access_token',
    );
    fetchMock.mockRestore();
  });

  it('fetchUserInfo throws on a non-OK userinfo response', async () => {
    const svc = new CasdoorService();
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    await expect((svc as any).fetchUserInfo('tok')).rejects.toThrow('userinfo failed: 401');
    fetchMock.mockRestore();
  });

  it('throws if any required Casdoor env is missing', () => {
    delete process.env.CASDOOR_CLIENT_SECRET;
    expect(() => new CasdoorService()).toThrow(/CASDOOR_CLIENT_SECRET/);
  });
});
