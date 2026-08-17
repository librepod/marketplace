import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import * as yaml from 'js-yaml';

@Injectable()
export class GogsService implements OnModuleInit {
  private readonly logger = new Logger(GogsService.name);
  private apiToken = '';

  constructor(private readonly config: ConfigService) {}

  private get gogsUrl(): string {
    // Trailing dot = absolute FQDN. Required: without it, on a host carrying a
    // `libre.pod` search domain (every LibrePod device + dev box), the bare
    // `*.svc.cluster.local` name is resolved with the search suffix appended first
    // and the coredns-custom libre.pod rewrite sends it to Traefik, whose global
    // HTTP->HTTPS redirect + untrusted default cert makes every Gogs call fail.
    // The trailing dot skips the resolver search list. See marketplace-ui configmap.
    return this.config.get<string>(
      'GOGS_URL',
      'http://gogs.gogs.svc.cluster.local.:80',
    );
  }

  private get gogsUsername(): string {
    return this.config.get<string>('GOGS_USERNAME', '');
  }

  private get gogsPassword(): string {
    return this.config.get<string>('GOGS_TOKEN', '');
  }

  private get basicAuth(): string {
    const credentials = Buffer.from(`${this.gogsUsername}:${this.gogsPassword}`).toString('base64');
    return `Basic ${credentials}`;
  }

  async onModuleInit(): Promise<void> {
    // Best-effort warm-up so the first request is fast and the happy path logs a
    // clear "token created" line. NOT the single point of failure: token
    // acquisition is retried lazily at each call site (see ensureToken) because
    // on a fresh cluster Gogs may not have created the flux admin user yet when
    // this runs — a one-shot bootstrap here would 403 and leave apiToken empty
    // for the container's whole lifetime, 500ing every install until a pod
    // restart. That is the Tier 2 install-500 flake.
    await this.ensureToken();
  }

  /**
   * Return a valid Gogs API token, bootstrapping one if we don't have it yet.
   * Idempotent: once a token is held it is returned without a network call.
   * Called before every authenticated request so a failed boot-time bootstrap
   * (e.g. the flux user not existing yet) self-heals on a later call instead of
   * wedging the container. Returns '' if bootstrap still fails, letting callers
   * apply their existing degradation (getInstalledAppNames → [], writes → throw).
   */
  private async ensureToken(): Promise<string> {
    if (this.apiToken) return this.apiToken;

    const tokensUrl = `${this.gogsUrl}/api/v1/users/${this.gogsUsername}/tokens`;
    try {
      const tokenName = `marketplace-ui-${crypto.randomUUID().slice(0, 8)}`;
      const res = await fetch(tokensUrl, {
        method: 'POST',
        headers: {
          Authorization: this.basicAuth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: tokenName }),
      });

      if (res.ok) {
        const data = (await res.json()) as { sha1: string };
        this.apiToken = data.sha1;
        this.logger.log('Created Gogs API token for write operations');
      } else {
        // 403 here is the expected "flux user not ready yet" case on a fresh
        // cluster; leave apiToken empty so the next call retries.
        this.logger.warn(
          `Gogs API token not yet available (HTTP ${res.status}); will retry on next request`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Gogs API token bootstrap failed: ${message}; will retry on next request`);
    }

    return this.apiToken;
  }

  /**
   * Like ensureToken() but for the WRITE path: bounded retry-with-backoff so the
   * first install/uninstall on a fresh cluster waits for Gogs to finish creating
   * the flux admin user instead of 500ing on the first click. ensureToken() alone
   * only self-heals across separate requests (the container stops wedging, but the
   * first click still 500s until the user retries) — this closes that first-click
   * race for the user-triggered action. Reads deliberately do NOT call this: they
   * use the single-shot ensureToken() and degrade instantly when Gogs is down, so
   * the UI never blocks on the retry budget during page load.
   *
   * Throws if no token can be obtained within the budget, so install() fails
   * before writing any files (a clean, meaningful error rather than a partial
   * write + generic 500).
   */
  async ensureWritableToken(): Promise<string> {
    const attempts = 5;
    const delayMs = 2000; // ~5 tries over ~8s of backoff-free waiting
    for (let i = 0; i < attempts; i++) {
      const token = await this.ensureToken();
      if (token) return token;
      if (i < attempts - 1) {
        this.logger.warn(
          `Gogs API token not ready (write path, attempt ${i + 1}/${attempts}); retrying in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw new Error(
      `Gogs API token unavailable after ${attempts} attempts — Gogs may still be provisioning`,
    );
  }

  async getInstalledAppNames(): Promise<string[]> {
    const url = `${this.gogsUrl}/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml`;
    try {
      const token = await this.ensureToken();
      const res = await fetch(url, {
        headers: { Authorization: `token ${token}` },
      });
      if (!res.ok) return [];
      const parsed = yaml.load(await res.text()) as { resources?: string[] } | null;
      // Root kustomization entries are paths like "apps/<name>" (and may carry a
      // trailing slash); strip to the bare app name callers compare against.
      return (parsed?.resources ?? [])
        .map((r: string) => r.replace(/^apps\//, '').replace(/\/$/, ''))
        .filter(Boolean);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Gogs unreachable, treating all apps as not_installed: ${message}`,
      );
      return [];
    }
  }

  async createFile(path: string, content: string, message: string): Promise<void> {
    const url = `${this.gogsUrl}/api/v1/repos/flux/user-apps/contents/${path}`;
    const token = await this.ensureToken();
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        content: Buffer.from(content).toString('base64'),
      }),
    });
    if (!res.ok) {
      throw new Error(`Gogs write failed for ${path}: ${res.status}`);
    }
  }

  async getFileContents(path: string): Promise<{ content: string; sha: string } | null> {
    const url = `${this.gogsUrl}/api/v1/repos/flux/user-apps/contents/${path}`;
    const token = await this.ensureToken();
    const res = await fetch(url, {
      headers: { Authorization: `token ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content: string; sha: string };
    return {
      content: Buffer.from(data.content, 'base64').toString('utf-8'),
      sha: data.sha,
    };
  }

  async addToRootKustomization(appName: string): Promise<void> {
    const existing = await this.getFileContents('kustomization.yaml');
    const parsed = yaml.load(existing?.content ?? '') as {
      apiVersion?: string;
      kind?: string;
      resources?: string[];
    } | null;
    const doc = parsed ?? {};
    const resources = doc.resources ?? [];

    const entry = `apps/${appName}`;
    if (!resources.includes(entry)) {
      resources.push(entry);
    }

    const updated = yaml.dump({ ...doc, resources }, { lineWidth: -1, noRefs: true });
    await this.createFile('kustomization.yaml', updated, `install: add ${appName}`);
  }

  async removeFromRootKustomization(appName: string): Promise<void> {
    const existing = await this.getFileContents('kustomization.yaml');
    const parsed = yaml.load(existing?.content ?? '') as {
      apiVersion?: string;
      kind?: string;
      resources?: string[];
    } | null;
    const doc = parsed ?? {};
    const resources = (doc.resources ?? []).filter((r: string) => r !== `apps/${appName}`);

    const updated = yaml.dump({ ...doc, resources }, { lineWidth: -1, noRefs: true });
    await this.createFile('kustomization.yaml', updated, `uninstall: remove ${appName}`);
  }
}
