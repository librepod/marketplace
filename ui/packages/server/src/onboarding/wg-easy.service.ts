import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { WgPeer } from '@librepod/shared';
import { DeviceAdminStore } from './device-admin.store';
import { OpenBaoClient } from '../installed/openbao.client';

/** The WireGuard UDP port clients dial — matches the app's Service and the
 * INIT_PORT default in wg-easy.env; setup/4 bakes it into client configs. */
const WG_ENDPOINT_PORT = 51820;

/**
 * wg-easy v15 API client. Every authenticated route accepts
 * `Authorization: Basic admin:<password>` (session.ts getCurrentUser —
 * re-verified against the live v15.4.0 source), so this is stateless.
 *
 * wg-easy is a system app whose admin account is a target of the
 * device-admin credential. A FRESH instance boots into its own first-boot
 * setup state (v15 completes unattended setup only when USERNAME+PASSWORD+
 * HOST+PORT are ALL set; INIT_HOST defaults empty because the endpoint host
 * is runtime knowledge — the device IP the user is browsing), so adoption
 * has two shapes:
 *
 *  - fresh: complete wg-easy's own setup API with the chosen password and
 *    the device IP (setup/2 user, setup/4 host+port). wg-easy writes its
 *    database itself — we never touch it.
 *  - already set up (clusters migrated from user installs): rotate through
 *    the API (`POST /api/me/password`), authenticating as whatever still
 *    works — the cached current password, else the OpenBao settings entry
 *    (apps/wg-easy INIT_PASSWORD, what the instance originally booted with).
 *
 * Both shapes persist the chosen password to DeviceAdminStore FIRST (so a
 * failed adoption never destroys the credential and lazy retries can finish
 * the job), and write {INIT_PASSWORD, INIT_HOST} back to the OpenBao entry
 * afterwards — with all four INIT_* then present, a PVC wipe re-initializes
 * wg-easy unattended with the same admin and endpoint.
 */
@Injectable()
export class WgEasyService {
  private readonly logger = new Logger(WgEasyService.name);
  private readonly baseUrl = (process.env.WGEASY_BASE_URL ?? '').replace(/\/$/, '');
  private password?: string;

  constructor(
    private readonly store: DeviceAdminStore,
    private readonly bao: OpenBaoClient,
  ) {}

  /** Claim-time: persist the chosen password (+ endpoint host) first, then
   * adopt best-effort. Throws only when the Secret cannot be persisted
   * (nothing has been adopted yet in that case, so the caller can defer). */
  async adoptPassword(password: string, host?: string): Promise<void> {
    await this.store.save(password, host);
    try {
      await this.ensurePassword(password, host);
      await this.writeBack(password, host);
    } catch (err) {
      this.logger.warn(`wg-easy adoption deferred: ${String(err)}`);
    }
  }

  /** A working wg-easy admin password. The credential we WANT is the user's
   * choice at claim time, else the persisted one — we never invent one.
   * If `wanted` already authenticates, done. Otherwise: complete first-boot
   * setup (fresh instance), else rotate from whatever still authenticates
   * (cached current, then the OpenBao entry) — persist-before-rotate so a
   * failure is retryable. */
  async ensurePassword(preferred?: string, host?: string): Promise<string> {
    // The cached password is authoritative for routine calls; only a
    // DIFFERENT preferred value (claim after an earlier cache) must force
    // the recovery paths below.
    if (this.password && (!preferred || preferred === this.password)) {
      return this.password;
    }
    const persisted = await this.store.load();
    const wanted = preferred ?? persisted.password;
    if (wanted && (await this.tryAuth(wanted))) {
      this.password = wanted;
      return wanted;
    }
    const setupHost = host ?? persisted.wgHost;
    if (wanted && setupHost && (await this.completeSetup(wanted, setupHost))) {
      await this.writeBack(wanted, setupHost);
      this.password = wanted;
      return wanted;
    }
    if (wanted) {
      const cached = this.password;
      const factory = await this.factoryPassword();
      for (const from of [cached, factory]) {
        if (!from || from === wanted) continue;
        if (await this.tryAuth(from)) {
          // persist before rotating (see class comment); keep the stored host
          await this.store.save(wanted, persisted.wgHost);
          const res = await fetch(`${this.baseUrl}/api/me/password`, {
            method: 'POST',
            headers: this.authHeaders(from),
            body: JSON.stringify({ currentPassword: from, newPassword: wanted }),
          });
          if (!res.ok) {
            throw new ServiceUnavailableException(`wg-easy password rotation failed: ${res.status}`);
          }
          this.logger.log('adopted the wanted password as the wg-easy admin password');
          await this.writeBack(wanted); // keep the entry in sync (PVC-wipe re-init)
          this.password = wanted;
          return wanted;
        }
      }
    }
    throw new ServiceUnavailableException('wg-easy admin credential unavailable');
  }

  /** Drive wg-easy's own first-boot setup (its setup API is unauthenticated
   * while setup is incomplete — the same open claim window as Casdoor's
   * factory credential, closed by completing it). False = already set up,
   * unreachable, or rejected; the caller falls through to rotation. */
  private async completeSetup(password: string, host: string): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const user = await fetch(`${this.baseUrl}/api/setup/2`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password, confirmPassword: password }),
      });
      if (!user.ok) return false;
      const iface = await fetch(`${this.baseUrl}/api/setup/4`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, port: WG_ENDPOINT_PORT }),
      });
      if (!iface.ok) return false;
      this.logger.log(`completed wg-easy first-boot setup (endpoint ${host}:${WG_ENDPOINT_PORT})`);
      return true;
    } catch {
      return false;
    }
  }

  /** Mirror the adopted credential into the OpenBao settings entry
   * (read-merge: writeAppSettings replaces the entry whole) so a PVC wipe
   * re-initializes wg-easy unattended. Best-effort — the marketplace-ui
   * Secret remains the durable copy. */
  private async writeBack(password: string, host?: string): Promise<void> {
    try {
      const entry = (await this.bao.readAppSettings('wg-easy')) ?? {};
      entry.INIT_PASSWORD = password;
      if (host) entry.INIT_HOST = host;
      await this.bao.writeAppSettings('wg-easy', entry);
    } catch (err) {
      this.logger.warn(`wg-easy openbao write-back deferred: ${String(err)}`);
    }
  }

  /** The value wg-easy originally booted with (bootstrap seed or a prior
   * install's answer) — the `from` candidate for rotating a drifted
   * instance. Read via OpenBao; the marketplace-ui policy grants it. */
  private async factoryPassword(): Promise<string | undefined> {
    try {
      return (await this.bao.readAppSettings('wg-easy'))?.INIT_PASSWORD?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private authHeaders(password: string): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
      'content-type': 'application/json',
    };
  }

  private async tryAuth(password: string): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const res = await fetch(`${this.baseUrl}/api/client`, { headers: this.authHeaders(password) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listClients(): Promise<WgPeer[]> {
    const res = await this.request('/api/client');
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    return raw.map((c) => ({
      clientId: String(c.clientId),
      name: String(c.name ?? ''),
      enabled: Boolean(c.enabled),
      latestHandshakeAt: (c.latestHandshakeAt as string | undefined) ?? null,
    }));
  }

  async createClient(name: string): Promise<{ clientId: string }> {
    const res = await this.request('/api/client', {
      method: 'POST',
      body: JSON.stringify({ name, expiresAt: null }),
    });
    const json = (await res.json()) as { clientId: string };
    return { clientId: json.clientId };
  }

  async clientConfiguration(clientId: string): Promise<string> {
    const res = await this.request(`/api/client/${clientId}/configuration`);
    return res.text();
  }

  async clientQrSvg(clientId: string): Promise<string> {
    const res = await this.request(`/api/client/${clientId}/qrcode.svg`);
    return res.text();
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const password = await this.ensurePassword();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.authHeaders(password),
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(`wg-easy ${path} failed: ${res.status}`);
    }
    return res;
  }
}
