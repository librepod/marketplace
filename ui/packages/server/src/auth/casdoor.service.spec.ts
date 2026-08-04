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
});
