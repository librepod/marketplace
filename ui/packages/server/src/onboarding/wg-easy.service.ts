import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { WgPeer } from '@librepod/shared';
import { DeviceAdminStore } from './device-admin.store';

/**
 * wg-easy v15 API client. Every route accepts
 * `Authorization: Basic admin:<password>` (session.ts getCurrentUser —
 * re-verified against the live v15.4.0 source), so this is stateless.
 * wg-easy's local admin is one of the device-admin credential's targets:
 * at claim time `adoptPassword(chosen)` rotates the factory password
 * (INIT_PASSWORD from the reflected wg-easy-admin Secret) to the same
 * password the user chose for Casdoor, persisting it first via
 * DeviceAdminStore. Order matters: persist BEFORE rotating, so a failed
 * persist never destroys the factory credential; a wg-easy outage during
 * claim defers the rotation (the lazy ensurePassword() picks the value up
 * from the Secret once wg-easy is reachable again).
 */
@Injectable()
export class WgEasyService {
  private readonly logger = new Logger(WgEasyService.name);
  private readonly baseUrl = (process.env.WGEASY_BASE_URL ?? '').replace(/\/$/, '');
  private password?: string;

  constructor(private readonly store: DeviceAdminStore) {}

  /** Claim-time: persist the chosen password, then rotate best-effort.
   * Throws only when the Secret cannot be persisted (nothing has been
   * rotated yet in that case, so the caller can safely defer). */
  async adoptPassword(password: string): Promise<void> {
    await this.store.save(password);
    try {
      await this.ensurePassword(password);
    } catch (err) {
      this.logger.warn(`wg-easy password adoption deferred: ${String(err)}`);
    }
  }

  /** A working wg-easy admin password. `preferred` (the user's chosen
   * password) wins while the factory credential still works; otherwise the
   * persisted value; random is the never-expected fallback (Secret wiped
   * mid-tour) that at least closes the factory window. */
  async ensurePassword(preferred?: string): Promise<string> {
    if (this.password) return this.password;
    const persisted = await this.store.load();
    const candidate = preferred ?? persisted;
    if (candidate && (await this.tryAuth(candidate))) {
      this.password = candidate;
      return candidate;
    }
    const factory = this.factoryPassword();
    if (factory && (await this.tryAuth(factory))) {
      const target = candidate ?? crypto.randomBytes(24).toString('base64url');
      await this.store.save(target); // persist before rotating (see class comment)
      const res = await fetch(`${this.baseUrl}/api/me/password`, {
        method: 'POST',
        headers: this.authHeaders(factory),
        body: JSON.stringify({ currentPassword: factory, newPassword: target }),
      });
      if (!res.ok) {
        throw new ServiceUnavailableException(`wg-easy password rotation failed: ${res.status}`);
      }
      this.logger.log('adopted the chosen password as the wg-easy admin password');
      this.password = target;
      return target;
    }
    throw new ServiceUnavailableException('wg-easy admin credential unavailable');
  }

  private factoryPassword(): string | undefined {
    // Read per call (not at module load) so tests can point the env var at a
    // real temp file — the node:fs namespace is frozen and cannot be spied.
    const file = process.env.WGEASY_PASSWORD_FILE ?? '/etc/wg-easy/INIT_PASSWORD';
    try {
      return readFileSync(file, 'utf8').trim() || undefined;
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
