import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';

interface CasdoorResponse {
  status: string;
  msg?: string;
  data?: unknown;
}

/** A signed-in built-in admin: the session cookie and the password that opened it. */
export interface CasdoorSession {
  cookie: string;
  password: string;
}

/** The org's group whose members administer the platform. */
const ADMINS_GROUP = 'admins';

/** Upper bound on one Casdoor call: a hung Casdoor must not hang the wizard. */
const TIMEOUT_MS = 10_000;

/**
 * Casdoor's admin API as the built-in admin — Casdoor's superuser, LibrePod's
 * `admin`. Casdoor v3.106 accepts only its own beego session cookie on
 * /api/set-password, so every operation starts with signIn() (POST /api/login,
 * the login page's anonymous endpoint) and replays the cookie it returns.
 * Casdoor answering 5xx or non-JSON means "down" (503), never "wrong password".
 */
@Injectable()
export class CasdoorAdminService {
  private readonly baseUrl = (process.env.CASDOOR_BASE_URL ?? '').replace(/\/$/, '');
  private readonly org = process.env.CASDOOR_ORG_NAME ?? 'librepod';
  private readonly baseDomain = process.env.BASE_DOMAIN ?? 'libre.pod';

  /** Casdoor's factory admin password, replaced at marketplace-ui's first start. The
   * casdoor-sso-controller still uses it for its first key mint. */
  get factoryPassword(): string {
    return process.env.CASDOOR_ADMIN_DEFAULT_PASSWORD ?? '123';
  }

  /** Up and answering. OIDC discovery is unauthenticated JSON and cheap. */
  async reachable(): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const res = await fetch(`${this.baseUrl}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return res.ok && (await res.json().catch(() => null)) !== null;
    } catch {
      return false;
    }
  }

  /** Signs in as the built-in admin with the first candidate Casdoor accepts, in
   * order; empty and repeated candidates are skipped. null = all rejected. */
  async signIn(candidates: string[]): Promise<CasdoorSession | null> {
    for (const password of [...new Set(candidates)].filter((p) => p !== '')) {
      const res = await this.request('/api/login', {
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
      const json = await this.parse(res, '/api/login');
      if (json.status === 'ok') {
        const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
        return { cookie, password };
      }
    }
    return null;
  }

  async setAdminPassword(session: CasdoorSession, newPassword: string): Promise<void> {
    await this.setPassword(session, 'built-in', 'admin', session.password, newPassword);
  }

  /** The platform org. Nothing else creates it on a fresh device (casdoor-sso-controller
   * only adds applications to it), so this is its real creation. Organizations belong
   * to "admin". add-organization leaves passwordType empty, and Casdoor then refuses
   * every password sign-in in the org ("unsupported password type"); bcrypt is what
   * Casdoor's own UI gives a new org. */
  async ensureOrganization(session: CasdoorSession): Promise<void> {
    if (await this.getJson(session, `/api/get-organization?id=admin/${encodeURIComponent(this.org)}`)) return;
    await this.postJson(session, '/api/add-organization', {
      owner: 'admin',
      name: this.org,
      displayName: 'LibrePod',
      passwordType: 'bcrypt',
    });
  }

  /** Group ids in `user.groups` and the token's `groups` claim are `<org>/<name>`. */
  get adminsGroupId(): string {
    return `${this.org}/${ADMINS_GROUP}`;
  }

  /** The top-level `admins` group of the platform org; nothing else creates it. */
  async ensureGroup(session: CasdoorSession): Promise<void> {
    if (await this.getJson(session, `/api/get-group?id=${this.adminsGroupId}`)) return;
    await this.postJson(session, '/api/add-group', {
      owner: this.org,
      name: ADMINS_GROUP,
      displayName: 'Admins',
      type: 'Virtual',
      parentId: this.org,
      isTopGroup: true,
      isEnabled: true,
    });
  }

  /** Adds an existing user to `admins`; false = no such user. Posts the user as fetched with
   * columns=groups, so Casdoor rewrites only the memberships, not the password or profile. */
  async ensureInGroup(session: CasdoorSession, name: string): Promise<boolean> {
    const id = `${encodeURIComponent(this.org)}/${encodeURIComponent(name)}`;
    const user = (await this.getJson(session, `/api/get-user?id=${id}`)) as { groups?: string[] } | null;
    if (!user) return false;
    const groups = user.groups ?? [];
    if (!groups.includes(this.adminsGroupId)) {
      await this.postJson(session, `/api/update-user?id=${id}&columns=groups`, {
        ...user,
        groups: [...groups, this.adminsGroupId],
      });
    }
    return true;
  }

  async getUser(session: CasdoorSession, name: string): Promise<{ name: string } | null> {
    const id = `${encodeURIComponent(this.org)}/${encodeURIComponent(name)}`;
    return (await this.getJson(session, `/api/get-user?id=${id}`)) as { name: string } | null;
  }

  /** A personal user, `<name>@<base-domain>`: admin of the platform org, not of Casdoor. */
  async addUser(session: CasdoorSession, name: string, password: string, groups: string[] = []): Promise<void> {
    await this.postJson(session, '/api/add-user', {
      owner: this.org,
      name,
      displayName: name,
      email: `${name}@${this.baseDomain}`,
      password,
      isAdmin: true,
      type: 'normal-user',
      groups,
    });
  }

  /** Casdoor's admin needs no old password to set another user's. */
  async setUserPassword(session: CasdoorSession, name: string, newPassword: string): Promise<void> {
    await this.setPassword(session, this.org, name, '', newPassword);
  }

  private async setPassword(
    session: CasdoorSession,
    userOwner: string,
    userName: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const res = await this.request('/api/set-password', {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ userOwner, userName, oldPassword, newPassword }),
    });
    this.expectOk(await this.parse(res, '/api/set-password'), '/api/set-password');
  }

  private async getJson(session: CasdoorSession, path: string): Promise<unknown> {
    const json = await this.parse(await this.request(path, { headers: { cookie: session.cookie } }), path);
    this.expectOk(json, path);
    return json.data ?? null;
  }

  private async postJson(session: CasdoorSession, path: string, payload: unknown): Promise<void> {
    const res = await this.request(path, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    this.expectOk(await this.parse(res, path), path);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    if (!this.baseUrl) throw new ServiceUnavailableException('Casdoor is not configured (CASDOOR_BASE_URL).');
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new ServiceUnavailableException("Single sign-on (Casdoor) isn't reachable yet — try again in a minute.");
    }
  }

  private async parse(res: Response, path: string): Promise<CasdoorResponse> {
    const json = (await res.json().catch(() => null)) as CasdoorResponse | null;
    if (!res.ok || !json) {
      throw new ServiceUnavailableException(`Casdoor ${path} answered HTTP ${res.status} — try again in a minute.`);
    }
    return json;
  }

  private expectOk(json: CasdoorResponse, path: string): void {
    if (json.status !== 'ok') throw new BadGatewayException(`Casdoor refused ${path}: ${json.msg ?? 'no reason given'}`);
  }
}
