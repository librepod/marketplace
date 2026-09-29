import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import type { SessionService } from './session.service';

function guardWith(claims: unknown) {
  const session = { verify: vi.fn().mockReturnValue(claims) } as unknown as SessionService;
  return { guard: new AuthGuard(session), session };
}

function req(url = '/api/apps', cookie = 'tok') {
  return { url, cookies: { mp_session: cookie } } as never;
}

function ctx(reqObj: unknown) {
  return { switchToHttp: () => ({ getRequest: () => reqObj }) } as never;
}

describe('AuthGuard', () => {
  it('passes public urls without a session', () => {
    const { guard, session } = guardWith(null);
    expect(guard.canActivate(ctx(req('/api/health')))).toBe(true);
    expect(session.verify).not.toHaveBeenCalled();
  });

  it('passes a valid session and attaches the claims as req.user', () => {
    const claims = { sub: 'admin', name: 'admin', email: 'a@b.c', iat: 1, exp: 2 };
    const { guard } = guardWith(claims);
    const r = req();
    expect(guard.canActivate(ctx(r))).toBe(true);
    expect((r as { user?: unknown }).user).toBe(claims);
  });

  it('rejects the onboarding token replayed as a session (same HMAC, wrong audience)', () => {
    // The mp_onboarding cookie is signed by the same SessionService — verify()
    // succeeds HMAC-wise, so the sub check is the only thing standing between
    // the wizard token and full authenticated API access.
    const { guard } = guardWith({ sub: 'onboarding', name: 'onboarding', email: '', iat: 1, exp: 2 });
    expect(() => guard.canActivate(ctx(req()))).toThrow(UnauthorizedException);
  });

  it('rejects a missing/invalid token', () => {
    const { guard } = guardWith(null);
    expect(() => guard.canActivate(ctx(req()))).toThrow(UnauthorizedException);
  });
});
