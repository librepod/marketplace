import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';

/** Any reason the settings store can't take a write right now: unset, down, sealed, auth. */
export class OpenBaoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenBaoUnavailableError';
  }
}

/**
 * Upper bound on one OpenBao request. Installs run behind a global mutex, so a server
 * that accepts the connection but never answers would otherwise stall every install.
 */
const REQUEST_TIMEOUT_MS = 10_000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * The installer's view of OpenBao: a Kubernetes-auth login and one KV v2 write.
 * Plain fetch, no SDK. Errors carry only the operation and the HTTP status — never
 * the values being written — so a secret cannot leak into a log line.
 *
 * OPENBAO_TOKEN is a test seam (Tier 1's dev-mode OpenBao has no Kubernetes auth);
 * cluster manifests must never set it.
 */
@Injectable()
export class OpenBaoClient {
  private token?: CachedToken;

  constructor(private readonly config: ConfigService) {}

  private get addr(): string {
    return this.config.get<string>('OPENBAO_ADDR', '').replace(/\/+$/, '');
  }

  /** Replaces the whole KV v2 entry apps/<app>: a new version; earlier ones stay as history. */
  async writeAppSettings(app: string, data: Record<string, string>): Promise<void> {
    if (!this.addr) throw new OpenBaoUnavailableError('OPENBAO_ADDR is not set');
    const mount = this.config.get<string>('OPENBAO_KV_MOUNT', 'secret');
    const url = `${this.addr}/v1/${mount}/data/apps/${encodeURIComponent(app)}`;

    let res = await this.post(url, { data }, { 'X-Vault-Token': await this.clientToken() });
    if (res.status === 403 && this.token) {
      // The cached login token expired or was revoked early: log in again, once.
      this.token = undefined;
      res = await this.post(url, { data }, { 'X-Vault-Token': await this.clientToken() });
    }
    if (!res.ok) throw new OpenBaoUnavailableError(`write apps/${app} failed: HTTP ${res.status}`);
  }

  private async post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new OpenBaoUnavailableError(`OpenBao unreachable: ${(err as Error).message}`);
    }
  }

  private async clientToken(): Promise<string> {
    const staticToken = this.config.get<string>('OPENBAO_TOKEN', '');
    if (staticToken) return staticToken;
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;

    const tokenPath = this.config.get<string>(
      'OPENBAO_SA_TOKEN_PATH',
      '/var/run/secrets/kubernetes.io/serviceaccount/token',
    );
    let jwt: string;
    try {
      jwt = (await readFile(tokenPath, 'utf8')).trim();
    } catch {
      throw new OpenBaoUnavailableError(`cannot read the ServiceAccount token at ${tokenPath}`);
    }

    const authMount = this.config.get<string>('OPENBAO_AUTH_MOUNT', 'kubernetes');
    const role = this.config.get<string>('OPENBAO_AUTH_ROLE', 'marketplace-ui');
    const res = await this.post(`${this.addr}/v1/auth/${authMount}/login`, { role, jwt });
    if (!res.ok) throw new OpenBaoUnavailableError(`login failed: HTTP ${res.status}`);

    let auth: { client_token?: string; lease_duration?: number } | undefined;
    try {
      auth = ((await res.json()) as { auth?: typeof auth }).auth;
    } catch {
      throw new OpenBaoUnavailableError('login response was not JSON');
    }
    if (!auth?.client_token) throw new OpenBaoUnavailableError('login response had no client token');
    const lease = auth.lease_duration ?? 0;
    // Refresh a minute early; a 0 lease means the token does not expire.
    this.token = {
      value: auth.client_token,
      expiresAt: lease > 0 ? Date.now() + Math.max(lease - 60, 0) * 1000 : Number.POSITIVE_INFINITY,
    };
    return this.token.value;
  }
}
