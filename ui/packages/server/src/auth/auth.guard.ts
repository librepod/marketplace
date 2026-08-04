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
    if (!claims) {
      throw new UnauthorizedException();
    }
    (req as { user?: unknown }).user = claims;
    return true;
  }

  /** Public surface: liveness/readiness probes + the auth endpoints
   * themselves (login must be reachable without a session). */
  private isPublic(url: string): boolean {
    return url === '/api/health' || url.startsWith('/api/auth/');
  }
}
