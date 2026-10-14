import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';
import type { Request, Response } from 'express';
import type { BootstrapInstallRequest, InstallResult, OnboardingState, OnboardingStatus } from '@librepod/shared';
import { SessionService, SESSION_COOKIE } from '../auth/session.service';
import { InstalledService } from '../installed/installed.service';
import { NodeAddressService } from '../installed/node-address.service';
import { CasdoorAdminService } from './casdoor-admin.service';
import { OnboardingStore, type OnboardingRecord } from './onboarding-store';
import { ONBOARDING_COOKIE, OnboardingGuard, isOnboardingSession } from './onboarding.guard';
import { OnboardingService } from './onboarding.service';
import { WgEasyService } from './wg-easy.service';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

/** The VPN app whose state the wizard follows. */
const VPN_APP = 'wg-easy';
/** Apps the wizard may install, each with the install question the server answers
 * with the admin password (system/admin): the browser never sends it. */
const VPN_APPS: Readonly<Record<string, { adminPasswordSetting: string }>> = {
  'wg-easy': { adminPasswordSetting: 'INIT_PASSWORD' },
};

/** The bare host the browser used (no port, no IPv6 brackets). */
function hostOf(req: Request): string {
  const xfh = req.headers['x-forwarded-host'];
  const raw = (Array.isArray(xfh) ? xfh[0] : xfh) ?? req.headers.host ?? '';
  // "[2001:db8::1]:8080" → "2001:db8::1"; "192.168.1.1:80" → "192.168.1.1"
  return raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
}

const isIpv6 = (host: string) => host.includes(':') && IPV6.test(host);

/** An IP literal another device could dial: not loopback, link-local or unspecified. */
function dialable(host: string): boolean {
  if (IPV4.test(host)) return !/^(127\.|169\.254\.|0\.)/.test(host);
  if (isIpv6(host)) return !/^(::1?$|fe[89ab])/i.test(host);
  return false;
}

/** Who sent the request, for logs only. */
function sourceOf(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.ip || 'unknown';
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** First-run onboarding over HTTP (spec §10). Exempt from AuthGuard; the
 * cookie-gated endpoints carry OnboardingGuard. */
@Controller('bootstrap')
export class BootstrapController {
  private readonly logger = new Logger(BootstrapController.name);

  constructor(
    private readonly onboarding: OnboardingService,
    private readonly store: OnboardingStore,
    private readonly casdoor: CasdoorAdminService,
    private readonly wgEasy: WgEasyService,
    private readonly session: SessionService,
    private readonly config: ConfigService,
    private readonly installed: InstalledService,
    private readonly nodeAddress: NodeAddressService,
  ) {}

  /** Public and read-only; never sets a cookie. Telemetry only with a valid onboarding cookie. */
  @Get('status')
  async status(@Req() req: Request): Promise<OnboardingStatus> {
    const host = hostOf(req);
    const status: OnboardingStatus = {
      state: 'waiting',
      arrival: IPV4.test(host) || isIpv6(host) ? 'ip' : 'domain',
      baseDomain: this.config.get<string>('BASE_DOMAIN', 'libre.pod'),
      session: false,
      account: null,
      previousAccount: null,
      vpnStatus: null,
      peerCount: null,
      lastHandshakeAt: null,
      endpointSuggestion: null,
    };
    const override = process.env.BOOTSTRAP_MODE_OVERRIDE as OnboardingState | undefined;
    if (override) return { ...status, state: override };

    const cookies = req.cookies as Record<string, string> | undefined;
    // A signed-in user always gets the app: an OpenBao or Casdoor blip must never
    // tell them their device is "waking up". Raw-IP browsers never carry this
    // cookie (Secure, bound to the domain).
    const sso = this.session.verify(cookies?.[SESSION_COOKIE]);
    if (sso && sso.sub !== 'onboarding') {
      // Retries the SSO callback's finish write if it failed — the only write in a GET.
      void this.store
        .finishIfClaimed(sso.iat * 1000)
        .catch((err: Error) => this.logger.warn(`finishing onboarding failed: ${err.message}`));
      return { ...status, state: 'finished' };
    }

    let record: OnboardingRecord;
    try {
      record = await this.store.record();
    } catch {
      return status; // waiting: OpenBao can't answer
    }
    if (record.state !== 'finished' && !(await this.casdoor.reachable())) return status;
    status.state = record.state;
    status.session = isOnboardingSession(this.session, cookies?.[ONBOARDING_COOKIE], record);
    if (!status.session) return status;

    const confirmed = record.account !== null && record.accountGeneration === record.generation;
    status.account = confirmed ? record.account : null;
    status.previousAccount = confirmed ? null : record.account;
    status.vpnStatus = await this.installed.appStatus(VPN_APP).catch(() => null);
    // Not installed means no peers to count: skip the wg-easy call.
    if (status.vpnStatus !== 'not_installed') {
      try {
        const peers = await this.wgEasy.listClients();
        status.peerCount = peers.length;
        status.lastHandshakeAt =
          peers
            .map((p) => p.latestHandshakeAt)
            .filter((t): t is string => Boolean(t))
            .sort()
            .at(-1) ?? null;
      } catch {
        // still rolling out, or not answering yet — the next poll asks again
      }
    }
    status.endpointSuggestion = dialable(host) ? host : await this.nodeAddress.internalIp().catch(() => null);
    return status;
  }

  @Post('claim')
  @HttpCode(200)
  async claim(
    @Body() body: { code?: unknown; password?: unknown } | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const record = await this.onboarding.claim({ code: body?.code, password: body?.password }, sourceOf(req));
    this.setOnboardingCookie(res, record.generation);
    return { ok: true };
  }

  @Post('resume')
  @HttpCode(200)
  async resume(
    @Body() body: { code?: unknown } | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const record = await this.onboarding.resume(body?.code, sourceOf(req));
    this.setOnboardingCookie(res, record.generation);
    return { ok: true };
  }

  @Post('account')
  @HttpCode(200)
  @UseGuards(OnboardingGuard)
  async account(@Body() body: { username?: unknown; password?: unknown } | undefined): Promise<{ ok: true }> {
    await this.onboarding.account({ username: body?.username, password: body?.password });
    return { ok: true };
  }

  /** The wizard's VPN install through the catalog's own install path (same validation,
   * OpenBao write and Gogs commit). Errors pass through: 400 field errors, 409 already
   * installed (the wizard counts it as success), 503 retryable. */
  @Post('install')
  @HttpCode(200)
  @UseGuards(OnboardingGuard)
  async install(@Body() body: Partial<BootstrapInstallRequest> | undefined): Promise<InstallResult> {
    const app = body?.app;
    if (typeof app !== 'string' || !Object.hasOwn(VPN_APPS, app)) {
      throw new BadRequestException('Only a VPN app can be installed from setup');
    }
    const adminPassword = await this.onboarding.adminPassword();
    const settings = body?.settings;
    const answers = isPlainObject(settings) ? (settings as Record<string, string>) : {};
    return this.installed.install(app, {
      settings: { ...answers, [VPN_APPS[app].adminPasswordSetting]: adminPassword },
    });
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

  /** httpOnly, NOT Secure: the wizard IS the http://<ip> experience, and a Secure
   * cookie would be silently dropped there. Bound to the record's generation. */
  private setOnboardingCookie(res: Response, generation: number): void {
    const token = this.session.sign({ sub: 'onboarding', name: 'onboarding', email: '', generation });
    res.cookie(ONBOARDING_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: this.session.ttlSeconds * 1000,
    });
  }
}
