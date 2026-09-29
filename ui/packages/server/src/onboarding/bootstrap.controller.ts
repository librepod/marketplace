import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';
import type { Request, Response } from 'express';
import type { OnboardingStatus } from '@librepod/shared';
import { CasdoorAdminService } from './casdoor-admin.service';
import { WgEasyService } from './wg-easy.service';
import { SessionService, SESSION_COOKIE } from '../auth/session.service';
import { ONBOARDING_COOKIE } from './onboarding.guard';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function arrivalOf(req: Request): 'ip' | 'domain' {
  const xfh = req.headers['x-forwarded-host'];
  const raw = (Array.isArray(xfh) ? xfh[0] : xfh) ?? req.headers.host ?? '';
  // "[2001:db8::1]:8080" → "2001:db8::1"; "192.168.1.1:80" → "192.168.1.1"
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
  const ipv6 = host.includes(':') && /^[0-9a-fA-F:]+$/.test(host);
  return IPV4.test(host) || ipv6 ? 'ip' : 'domain';
}

@Controller('bootstrap')
export class BootstrapController {
  private readonly logger = new Logger(BootstrapController.name);
  /** Set once the factory login is rejected (or this process claimed) so
   * ready clusters stop hammering /api/login on every status poll. */
  private claimedCached = false;

  constructor(
    private readonly casdoorAdmin: CasdoorAdminService,
    private readonly wgEasy: WgEasyService,
    private readonly session: SessionService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  async status(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<OnboardingStatus> {
    const cookies = req.cookies as Record<string, string> | undefined;
    // A valid session proves the cluster was claimed — a transient casdoor
    // outage (or the very first probe after this pod restarts) must not tell
    // an authenticated user their device is "waking up". The onboarding
    // token (same HMAC) explicitly does NOT count.
    const sessionClaims = this.session.verify(cookies?.[SESSION_COOKIE]);
    const authenticated = !!sessionClaims && sessionClaims.sub !== 'onboarding';
    const probe =
      authenticated || this.claimedCached ? 'rejected' : await this.casdoorAdmin.probeFactoryLogin();
    if (probe === 'rejected') this.claimedCached = true;

    const status: OnboardingStatus = {
      mode: probe === 'unreachable' ? 'waiting' : probe === 'ok' ? 'onboarding' : 'ready',
      arrival: arrivalOf(req),
      baseDomain: this.config.get<string>('BASE_DOMAIN', 'libre.pod'),
      casdoorUp: probe !== 'unreachable',
      wgEasyUp: false,
      adminClaimed: probe === 'rejected' ? true : probe === 'ok' ? false : null,
      peerCount: null,
      lastHandshakeAt: null,
    };
    const override = process.env.BOOTSTRAP_MODE_OVERRIDE as OnboardingStatus['mode'] | undefined;
    if (override) status.mode = override;

    // Tour telemetry, and only for raw-IP arrivals — the pre-auth screens
    // that need it never appear over the domain, and domain browsers have no
    // business learning peer counts or the owner's last handshake time.
    // Never queried pre-claim (rotation must not be a side effect of a GET
    // poll; it happens in claim or the wg endpoints).
    if (status.adminClaimed && status.arrival === 'ip') {
      try {
        const peers = await this.wgEasy.listClients();
        status.wgEasyUp = true;
        status.peerCount = peers.length;
        status.lastHandshakeAt =
          peers
            .map((p) => p.latestHandshakeAt)
            .filter((t): t is string => Boolean(t))
            .sort()
            .at(-1) ?? null;
      } catch {
        status.wgEasyUp = false;
      }
    }

    // Mint while the TOUR is open — unclaimed, or claimed with no handshake
    // yet — and only for raw-IP arrivals (the wizard's home; pre-claim the
    // domain does not even resolve). A cookie that expired mid-tour must be
    // re-mintable or the Connect step becomes an unrecoverable 401 dead end.
    // Once a handshake is seen the tour is over and nobody can mint again —
    // and domain arrivals never mint, so their withheld telemetry cannot
    // wedge the tour open.
    const tourOpen =
      status.arrival === 'ip' &&
      (status.mode === 'onboarding' || (status.adminClaimed === true && !status.lastHandshakeAt));
    if (tourOpen) {
      this.mintOnboardingCookie(res);
    }
    return status;
  }

  @Post('claim')
  async claim(
    body: { password?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const password = body?.password ?? '';
    if (password.length < 8 || /\s/.test(password)) {
      throw new BadRequestException('password must be at least 8 characters without spaces');
    }
    await this.casdoorAdmin.claim({ password });
    this.claimedCached = true;
    // The device-admin credential's second target: adopt the same password on
    // wg-easy. Failure is non-fatal — adoptPassword persisted-first, so the
    // lazy ensurePassword() retries on the next wg call.
    try {
      await this.wgEasy.adoptPassword(password);
    } catch (err) {
      this.logger.warn(`wg-easy password adoption deferred: ${String(err)}`);
    }
    this.mintOnboardingCookie(res);
    return { ok: true };
  }

  @Get('ca')
  ca(@Res() res: Response): void {
    const path = process.env.ROOT_CA_PATH;
    if (!path || !existsSync(path)) {
      throw new NotFoundException('root CA not available');
    }
    // Public by design — the same cert root-ca.<domain> serves unauthenticated.
    res.setHeader('content-type', 'application/x-x509-ca-cert');
    res.setHeader('content-disposition', 'attachment; filename="librepod-root-ca.crt"');
    res.send(readFileSync(path));
  }

  /** httpOnly, NOT Secure: the wizard IS the http://<ip> experience, and a
   * Secure cookie would be silently dropped by the browser there. The token
   * only proves presence before the factory window closed; it grants nothing
   * the tour does not already grant, and expires with it. */
  private mintOnboardingCookie(res: Response): void {
    const token = this.session.sign({ sub: 'onboarding', name: 'onboarding', email: '' });
    res.cookie(ONBOARDING_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: this.session.ttlSeconds * 1000,
    });
  }
}
