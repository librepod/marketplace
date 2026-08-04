import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as yaml from 'js-yaml';

@Injectable()
export class GogsService {
  private readonly logger = new Logger(GogsService.name);

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

  async getInstalledAppNames(): Promise<string[]> {
    const url = `${this.gogsUrl}/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: this.basicAuth },
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
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: this.basicAuth,
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
    const res = await fetch(url, {
      headers: { Authorization: this.basicAuth },
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
