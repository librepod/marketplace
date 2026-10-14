import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SessionService } from '../auth/session.service';
import { OnboardingStore, STORE_UNAVAILABLE, type OnboardingRecord } from './onboarding-store';

export const ONBOARDING_COOKIE = 'mp_onboarding';

/** A valid onboarding cookie for the record's current generation, while it is claimed.
 * A cookie from before a reset, or any cookie once onboarding finished, is not one. */
export function isOnboardingSession(
  session: SessionService,
  token: string | undefined,
  record: OnboardingRecord,
): boolean {
  const claims = session.verify(token);
  return (
    !!claims && claims.sub === 'onboarding' && record.state === 'claimed' && claims.generation === record.generation
  );
}

/**
 * Gates the wizard's account, VPN install and WireGuard endpoints. The cookie is set
 * only by the claim and by resume (both need the setup code); it is bound to the
 * record's generation, so `reset-onboarding` retires every cookie issued before it.
 * Fails closed: no answer from OpenBao is a 503.
 */
@Injectable()
export class OnboardingGuard implements CanActivate {
  constructor(
    private readonly session: SessionService,
    private readonly store: OnboardingStore,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ cookies?: Record<string, string> }>();
    const token = req.cookies?.[ONBOARDING_COOKIE];
    // A forged or expired cookie is refused before OpenBao is asked anything.
    if (!this.session.verify(token)) throw new UnauthorizedException();
    let record: OnboardingRecord;
    try {
      record = await this.store.record();
    } catch {
      throw new ServiceUnavailableException(STORE_UNAVAILABLE);
    }
    if (!isOnboardingSession(this.session, token, record)) throw new UnauthorizedException();
    return true;
  }
}
