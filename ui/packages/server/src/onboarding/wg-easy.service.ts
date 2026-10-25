import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { WgPeer } from '@librepod/shared';
import { OpenBaoClient } from '../installed/openbao.client';

/**
 * wg-easy v15 API client for the onboarding wizard. Every permission-gated
 * route accepts `Authorization: Basic admin:<password>` (verified against
 * v15.4.0), so this is stateless.
 *
 * wg-easy is a regular catalog app that sets itself up: its generated install
 * setting INIT_PASSWORD (OpenBao apps/wg-easy, written by InstalledService.install)
 * plus INIT_HOST/INIT_PORT from its rendered ConfigMap complete its own
 * unattended first-boot setup. So the API credential is simply that setting,
 * read on every request — no copy is kept, and a reinstall that regenerates it
 * is picked up at once. If the owner later changes the password in wg-easy's
 * own UI, this copy goes stale and the wizard's peer calls fail with the 401
 * message below.
 */
@Injectable()
export class WgEasyService {
  private readonly baseUrl = (process.env.WGEASY_BASE_URL ?? '').replace(/\/$/, '');

  constructor(private readonly bao: OpenBaoClient) {}

  async listClients(): Promise<WgPeer[]> {
    const res = await this.request('/api/client');
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    return raw.map((c) => ({
      clientId: String(c.id),
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

  /** wg-easy's install answer. A missing entry and an unreadable store look
   * the same to the wizard: not available yet, try again. */
  private async adminPassword(): Promise<string> {
    let entry: Record<string, string> | null = null;
    try {
      entry = await this.bao.readAppSettings('wg-easy');
    } catch {
      // unreachable or misconfigured store — same answer as a missing entry
    }
    const password = entry?.INIT_PASSWORD;
    if (!password) throw new ServiceUnavailableException('wg-easy admin credential unavailable');
    return password;
  }

  private authHeaders(password: string): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
      'content-type': 'application/json',
    };
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    if (!this.baseUrl) throw new ServiceUnavailableException('wg-easy is not configured');
    const password = await this.adminPassword();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { ...init, headers: this.authHeaders(password) });
    } catch (err) {
      throw new ServiceUnavailableException(`wg-easy ${path} unreachable: ${String(err)}`);
    }
    if (res.status === 401) {
      // Setup is already done with a different password: the answer in OpenBao
      // never reached wg-easy. Say so, instead of a generic 503.
      throw new ServiceUnavailableException(
        'WireGuard rejected its admin password — it was changed in WireGuard itself, or a reinstall reused old WireGuard data.',
      );
    }
    if (!res.ok) {
      throw new ServiceUnavailableException(`wg-easy ${path} failed: ${res.status}`);
    }
    return res;
  }
}
