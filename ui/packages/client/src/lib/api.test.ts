import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from './api';

describe('apiFetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    Object.defineProperty(window, 'location', {
      value: { href: '', pathname: '/my-apps', search: '' },
      writable: true,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns the response on success', async () => {
    (global.fetch as any).mockResolvedValue(new Response('ok', { status: 200 }));
    const res = await apiFetch('/api/apps');
    expect(res.status).toBe(200);
  });

  it('redirects to /api/auth/login on 401', async () => {
    (global.fetch as any).mockResolvedValue(new Response('', { status: 401 }));
    await expect(apiFetch('/api/apps')).rejects.toThrow('unauthenticated');
    expect(window.location.href).toContain('/api/auth/login?rd=');
  });
});
