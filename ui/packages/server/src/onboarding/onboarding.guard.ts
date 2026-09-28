import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SessionService } from '../auth/session.service';

export const ONBOARDING_COOKIE = 'mp_onboarding';

/**
 * Gates the wizard's WireGuard endpoints. The cookie is minted only while
 * the factory window is open, so it proves "present before the door closed"
 * and expires with the tour — post-graduation, nobody can mint a new one.
 */
@Injectable()
export class OnboardingGuard implements CanActivate {
  constructor(private readonly session: SessionService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ cookies?: Record<string, string> }>();
    const claims = this.session.verify(req.cookies?.[ONBOARDING_COOKIE]);
    if (!claims || claims.sub !== 'onboarding') {
      throw new UnauthorizedException();
    }
    return true;
  }
}
