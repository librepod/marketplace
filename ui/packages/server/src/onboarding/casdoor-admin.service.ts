import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'node:crypto';

interface CasdoorResponse {
  status: string;
  msg?: string;
  data?: unknown;
}

export type FactoryProbe = 'ok' | 'rejected' | 'unreachable';

export interface ClaimInput {
  password: string;
}

/**
 * First-run takeover of the Casdoor built-in admin. The factory credential
 * (admin/123, see apps/casdoor-sso-controller/base/casdoor-sso-controller.env)
 * is simultaneously the bootstrap detector, the claim authorization, and the
 * security gate: once the takeover randomizes the built-in password, all three
 * evaporate together. No marker state exists anywhere.
 */
@Injectable()
export class CasdoorAdminService {
  private readonly logger = new Logger(CasdoorAdminService.name);
  private readonly baseUrl = (process.env.CASDOOR_BASE_URL ?? '').replace(/\/$/, '');
  private readonly factoryPassword = process.env.CASDOOR_ADMIN_DEFAULT_PASSWORD ?? '123';
  private readonly org = process.env.CASDOOR_ORG_NAME ?? 'librepod';

  /** Anonymous password login against the same endpoint the browser login
   * page uses. On success Casdoor sets a beego session cookie — the only
   * authorization /api/set-password accepts — so capture and return it.
   * `degraded` marks a non-JSON/5xx answer: casdoor is UP but erroring, which
   * must read as "unreachable", never as "wrong password" — a half-booted
   * casdoor would otherwise be latched as "claimed" for the process lifetime. */
  private async login(
    password: string,
  ): Promise<{ ok: boolean; degraded: boolean; cookie: string; msg?: string }> {
    const res = await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'login',
        application: 'app-built-in',
        organization: 'built-in',
        username: 'admin',
        password,
        autoSignin: true,
      }),
    });
    const json = (await res.json().catch(() => null)) as CasdoorResponse | null;
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (!res.ok || !json) {
      return { ok: false, degraded: true, cookie: '', msg: `HTTP ${res.status}` };
    }
    return { ok: json.status === 'ok', degraded: false, cookie: setCookies.join('; '), msg: json.msg };
  }

  /** 'ok' = factory window open (onboarding mode), 'rejected' = claimed,
   * 'unreachable' = casdoor still converging or degraded (waiting mode). */
  async probeFactoryLogin(): Promise<FactoryProbe> {
    if (!this.baseUrl) return 'unreachable';
    try {
      const r = await this.login(this.factoryPassword);
      if (r.degraded) return 'unreachable';
      return r.ok ? 'ok' : 'rejected';
    } catch (err) {
      this.logger.debug(`factory login probe failed: ${String(err)}`);
      return 'unreachable';
    }
  }

  /** Take over: ensure the platform org, ensure the fixed owner user in it,
   * then randomize the built-in admin's password. Every step is idempotent —
   * a failure is retried on the still-valid factory credential. The window
   * closes LAST, so an aborted claim never locks the cluster. */
  async claim(input: ClaimInput): Promise<void> {
    const login = await this.login(this.factoryPassword);
    if (login.degraded) {
      throw new ServiceUnavailableException('casdoor is up but erroring — retry shortly');
    }
    if (!login.ok) {
      throw new ConflictException('bootstrap already claimed');
    }
    await this.ensureOrganization(login.cookie);
    await this.ensureOwnerUser(login.cookie, input.password);
    await this.setPassword(login.cookie, crypto.randomBytes(24).toString('base64url'));
  }

  private async ensureOrganization(cookie: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/get-organization?id=${this.org}`, {
      headers: { cookie },
    });
    const json = (await res.json()) as CasdoorResponse;
    if (json.status === 'ok' && json.data) return;
    // The controller normally creates the platform org; this is an idempotent
    // belt-and-suspenders so a fresh cluster can never wedge the wizard.
    await this.postJson('/api/add-organization', cookie, {
      name: this.org,
      displayName: 'LibrePod',
    });
  }

  /** The single fixed owner identity: `admin` in the platform org. No
   * username is ever chosen — the wizard asks for a password only. */
  private async ensureOwnerUser(cookie: string, password: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/get-user?id=${this.org}/admin`, {
      headers: { cookie },
    });
    const json = (await res.json()) as CasdoorResponse;
    if (json.status === 'ok' && json.data) return;
    await this.postJson('/api/add-user', cookie, {
      owner: this.org,
      name: 'admin',
      displayName: 'admin',
      email: `admin@${process.env.BASE_DOMAIN ?? 'libre.pod'}`,
      password,
      isAdmin: true, // org admin of the platform org — manages users, not global objects
      type: 'normal-user',
    });
  }

  /** Randomize the built-in admin's password — closes the factory window. */
  private async setPassword(cookie: string, newPassword: string): Promise<void> {
    const body = new URLSearchParams({
      userOwner: 'built-in',
      userName: 'admin',
      oldPassword: this.factoryPassword,
      newPassword,
    });
    const res = await fetch(`${this.baseUrl}/api/set-password`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json().catch(() => ({ status: 'error' }))) as CasdoorResponse;
    if (json.status !== 'ok') {
      throw new Error(`set-password failed: ${json.msg ?? res.status}`);
    }
  }

  private async postJson(path: string, cookie: string, payload: unknown): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({ status: 'error' }))) as CasdoorResponse;
    if (json.status !== 'ok') {
      throw new Error(`casdoor ${path} failed: ${json.msg ?? res.status}`);
    }
  }
}
