import { describe, it, expect, beforeAll, vi } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SessionService } from '../auth/session.service';
import { OnboardingGuard, isOnboardingSession } from './onboarding.guard';
import type { OnboardingRecord, OnboardingStore } from './onboarding-store';

const claimed: OnboardingRecord = {
  state: 'claimed', code: '7KQMX3RT9VHC', generation: 3, account: null, accountGeneration: null,
  createdAt: 't', claimedAt: 'c', finishedAt: null,
};

let session: SessionService;
beforeAll(() => {
  process.env.SESSION_SECRET = 'onboarding-guard-spec';
  session = new SessionService();
});

const token = (claims: { sub: string; generation?: number }) =>
  session.sign({ name: claims.sub, email: '', ...claims });

function guardWith(record: OnboardingRecord | Error) {
  const store = {
    record: vi.fn(async () => {
      if (record instanceof Error) throw record;
      return record;
    }),
  };
  return { guard: new OnboardingGuard(session, store as unknown as OnboardingStore), store };
}

const ctx = (cookie?: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ cookies: cookie ? { mp_onboarding: cookie } : {} }) }),
  }) as never;

describe('OnboardingGuard', () => {
  it('admits the cookie for the current generation while the device is claimed', async () => {
    const { guard } = guardWith(claimed);
    await expect(guard.canActivate(ctx(token({ sub: 'onboarding', generation: 3 })))).resolves.toBe(true);
  });

  it('a missing or forged cookie is a 401 without asking OpenBao', async () => {
    const { guard, store } = guardWith(claimed);
    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx('forged.token'))).rejects.toThrow(UnauthorizedException);
    expect(store.record).not.toHaveBeenCalled();
  });

  it('a cookie from before a reset (older generation) is refused', async () => {
    const { guard } = guardWith(claimed);
    await expect(guard.canActivate(ctx(token({ sub: 'onboarding', generation: 2 })))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('nothing is admitted once finished, or while open', async () => {
    for (const state of ['finished', 'open'] as const) {
      const { guard } = guardWith({ ...claimed, state });
      await expect(guard.canActivate(ctx(token({ sub: 'onboarding', generation: 3 })))).rejects.toThrow(
        UnauthorizedException,
      );
    }
  });

  it('an SSO session token in the onboarding cookie is refused', async () => {
    const { guard } = guardWith(claimed);
    await expect(guard.canActivate(ctx(token({ sub: 'alex', generation: 3 })))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('OpenBao unreachable fails closed with a 503', async () => {
    const { guard } = guardWith(new Error('sealed'));
    await expect(guard.canActivate(ctx(token({ sub: 'onboarding', generation: 3 })))).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('isOnboardingSession is the same predicate, for status', () => {
    expect(isOnboardingSession(session, token({ sub: 'onboarding', generation: 3 }), claimed)).toBe(true);
    expect(isOnboardingSession(session, token({ sub: 'onboarding' }), claimed)).toBe(false);
    expect(isOnboardingSession(session, undefined, claimed)).toBe(false);
  });
});
