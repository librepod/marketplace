import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '@librepod/shared';
import type { SessionClaims } from './auth.types';

@Controller('me')
export class MeController {
  @Get()
  me(@Req() req: Request): User {
    // Populated by AuthGuard; if absent the guard already returned 401.
    // Return only the public subset — iat/exp stay server-side.
    const claims = (req as unknown as { user?: SessionClaims }).user;
    return { sub: claims!.sub, name: claims!.name, email: claims!.email };
  }
}
