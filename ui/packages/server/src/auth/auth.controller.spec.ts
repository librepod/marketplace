import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BadRequestException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import type { CasdoorService } from './casdoor.service';
import type { SessionService } from './session.service';
import type { OnboardingStore } from '../onboarding/onboarding-store';

function make(finishIfClaimed = vi.fn(async () => true)) {
  const casdoor = {
    exchangeCode: vi.fn(async () => ({ sub: 'alex', name: 'alex', email: 'alex@libre.pod' })),
  } as unknown as CasdoorService;
  const session = {
    sign: vi.fn(() => 'session-token'),
    cookieName: 'mp_session',
    ttlSeconds: 60,
  } as unknown as SessionService;
  const store = { finishIfClaimed } as unknown as OnboardingStore;
  return { controller: new AuthController(casdoor, session, store), finishIfClaimed };
}

function fakeRes() {
  return { cookie: vi.fn(), clearCookie: vi.fn(), redirect: vi.fn() } as unknown as Response & {
    cookie: ReturnType<typeof vi.fn>;
    redirect: ReturnType<typeof vi.fn>;
  };
}

const req = { cookies: { mp_oauth_state: 'state-1' }, headers: { 'x-forwarded-host': 'libre.pod' } } as unknown as Request;

describe('AuthController.callback', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('a successful sign-in finishes onboarding (the first one since the claim)', async () => {
    const { controller, finishIfClaimed } = make();
    const res = fakeRes();
    await controller.callback(req, res, 'code-1', 'state-1');
    expect(res.cookie).toHaveBeenCalledWith('mp_session', 'session-token', expect.anything());
    expect(finishIfClaimed).toHaveBeenCalledOnce();
    expect(res.redirect).toHaveBeenCalledWith(302, '/');
  });

  it('a failed finish write never fails the sign-in — status retries it', async () => {
    const { controller } = make(vi.fn(async () => { throw new Error('sealed'); }));
    const res = fakeRes();
    await controller.callback(req, res, 'code-1', 'state-1');
    expect(res.cookie).toHaveBeenCalledWith('mp_session', 'session-token', expect.anything());
    expect(res.redirect).toHaveBeenCalledWith(302, '/');
  });

  it('the redirect never waits on the finish write: a slow OpenBao delays no sign-in', async () => {
    let finish = (_done: boolean) => {};
    const { controller, finishIfClaimed } = make(vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve))));
    const res = fakeRes();
    const signIn = controller.callback(req, res, 'code-1', 'state-1');
    await vi.waitFor(() => expect(res.redirect).toHaveBeenCalledWith(302, '/'));
    expect(finishIfClaimed).toHaveBeenCalledOnce();
    finish(true);
    await signIn;
  });

  it('a bad state is refused before anything is finished', async () => {
    const { controller, finishIfClaimed } = make();
    await expect(controller.callback(req, fakeRes(), 'code-1', 'other-state')).rejects.toThrow(BadRequestException);
    expect(finishIfClaimed).not.toHaveBeenCalled();
  });
});
