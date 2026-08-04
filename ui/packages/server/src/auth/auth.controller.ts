import { BadRequestException, Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as crypto from 'node:crypto';
import { CasdoorService } from './casdoor.service';
import { SessionService, OAUTH_RD_COOKIE, OAUTH_STATE_COOKIE } from './session.service';

const OAUTH_STATE_TTL_SEC = 5 * 60; // 5 min for the round-trip to Casdoor

function hostOf(req: Request): string {
  // Traefik sets X-Forwarded-Host; fall back to Host.
  const xfh = req.headers['x-forwarded-host'];
  return (Array.isArray(xfh) ? xfh[0] : xfh) ?? req.headers.host ?? '';
}

function safeRelativeRd(rd: unknown): string {
  return typeof rd === 'string' && rd.startsWith('/') && !rd.startsWith('//') ? rd : '/';
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly casdoor: CasdoorService,
    private readonly session: SessionService,
  ) {}

  @Get('login')
  login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Query('rd') rd?: string) {
    const state = crypto.randomBytes(16).toString('hex');
    const host = hostOf(req);
    res.cookie(this.session.stateCookieName, state, cookieOpts(OAUTH_STATE_TTL_SEC));
    res.cookie(this.session.rdCookieName, safeRelativeRd(rd), cookieOpts(OAUTH_STATE_TTL_SEC));
    return res.redirect(302, this.casdoor.getAuthorizeUrl(host, state));
  }

  @Get('callback')
  async callback(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ) {
    const expected = req.cookies?.[OAUTH_STATE_COOKIE];
    if (!code || !state || !expected || state !== expected) {
      res.clearCookie(OAUTH_STATE_COOKIE);
      res.clearCookie(OAUTH_RD_COOKIE);
      throw new BadRequestException('invalid state parameter');
    }
    const identity = await this.casdoor.exchangeCode(code, hostOf(req));
    const token = this.session.sign(identity);
    res.cookie(this.session.cookieName, token, cookieOpts(this.session.ttlSeconds));
    res.clearCookie(OAUTH_STATE_COOKIE);
    const rd = safeRelativeRd(req.cookies?.[OAUTH_RD_COOKIE]);
    res.clearCookie(OAUTH_RD_COOKIE);
    return res.redirect(302, rd);
  }

  @Get('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    // Clears the browser's session cookie. Sessions are stateless HMAC tokens
    // with no revocation list, so a previously stolen cookie stays valid until
    // its TTL — accepted for the login-only scope; revisit in user management.
    res.clearCookie(this.session.cookieName);
    return res.redirect(302, '/api/auth/login');
  }
}

function cookieOpts(maxAgeSec: number) {
  return {
    httpOnly: true,
    // Secure by default (HTTPS only). Opt out with SESSION_COOKIE_SECURE=false
    // for local dev over plain HTTP (npm run dev on :3000/:5173).
    secure: process.env.SESSION_COOKIE_SECURE !== 'false',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSec * 1000,
  };
}
