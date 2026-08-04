import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import type { SessionClaims } from './auth.types';

export const SESSION_COOKIE = 'mp_session';
export const OAUTH_STATE_COOKIE = 'mp_oauth_state';
export const OAUTH_RD_COOKIE = 'mp_oauth_rd';
const TTL_SECONDS = 8 * 60 * 60; // 8h

// The default shipped in overlays/librepod/secret-session.yaml. Sessions are a
// stateless HMAC, so anyone with this constant can forge a valid cookie for any
// user. The server refuses to boot on it so "forgot to override" fails closed.
// Keep in sync with the default in secret-session.yaml.
const KNOWN_DEFAULT_SECRET = 'NZcbV2j7TK5DZTTEwD/tqssrP8CdDqHrjz/HpHjMJDg=';

@Injectable()
export class SessionService {
  private readonly secret: string;

  constructor() {
    this.secret = process.env.SESSION_SECRET ?? '';
    if (!this.secret) {
      throw new Error('SESSION_SECRET must be set');
    }
    if (this.secret === KNOWN_DEFAULT_SECRET) {
      throw new Error(
        'SESSION_SECRET is the committed default from secret-session.yaml — ' +
          'override it via MARKETPLACE_UI_SESSION_SECRET (Flux postBuild.substitute) ' +
          'or generate one with `openssl rand -base64 32`.',
      );
    }
  }

  get cookieName(): string {
    return SESSION_COOKIE;
  }
  get stateCookieName(): string {
    return OAUTH_STATE_COOKIE;
  }
  get rdCookieName(): string {
    return OAUTH_RD_COOKIE;
  }
  get ttlSeconds(): number {
    return TTL_SECONDS;
  }

  sign(claims: Omit<SessionClaims, 'iat' | 'exp'>): string {
    const now = Math.floor(Date.now() / 1000);
    return this.encode({ ...claims, iat: now, exp: now + TTL_SECONDS });
  }

  verify(token: string | undefined): SessionClaims | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expected = this.hmac(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let claims: SessionClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof claims.exp !== 'number' || Math.floor(Date.now() / 1000) >= claims.exp) {
      return null;
    }
    return claims;
  }

  private encode(claims: SessionClaims): string {
    const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    return `${body}.${this.hmac(body)}`;
  }

  private hmac(body: string): string {
    return crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
