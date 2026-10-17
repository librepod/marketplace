import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SessionService, SESSION_COOKIE } from './session.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly session: SessionService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ url: string; cookies?: Record<string, string> }>();
    if (this.isPublic(req.url)) {
      return true;
    }
    const claims = this.session.verify(req.cookies?.[SESSION_COOKIE]);
    // sub === 'onboarding' is the wizard's mp_onboarding token, signed with
    // the same HMAC — it must never authenticate as a session (its holder
    // only proved presence while the factory window was open).
    if (!claims || claims.sub === 'onboarding') {
      throw new UnauthorizedException();
    }
    (req as { user?: unknown }).user = claims;
    return true;
  }

  /** Public surface: liveness/readiness probes, the auth endpoints themselves
   * (login must be reachable without a session), and the first-run bootstrap
   * endpoints (the wizard runs before any SSO can exist — gating them on a
   * session would be the raw-IP dead end this flow exists to fix). The
   * wizard's WireGuard endpoints carry their own mp_onboarding-cookie guard. */
  private isPublic(url: string): boolean {
    return (
      url === '/api/health' ||
      url.startsWith('/api/auth/') ||
      url.startsWith('/api/bootstrap/')
    );
  }
}
