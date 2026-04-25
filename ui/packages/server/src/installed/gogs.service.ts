import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as yaml from 'js-yaml';

@Injectable()
export class GogsService {
  private readonly logger = new Logger(GogsService.name);

  constructor(private readonly config: ConfigService) {}

  private get gogsUrl(): string {
    return this.config.get<string>(
      'GOGS_URL',
      'http://gogs.gogs.svc.cluster.local:80',
    );
  }

  private get gogsToken(): string {
    return this.config.get<string>('GOGS_TOKEN', '');
  }

  async getInstalledAppNames(): Promise<string[]> {
    const url = `${this.gogsUrl}/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `token ${this.gogsToken}` },
      });
      if (!res.ok) return [];
      const text = await res.text();
      const parsed = yaml.load(text) as { resources?: string[] } | null;
      return (parsed?.resources ?? []).map((r: string) => r.replace(/\/$/, ''));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Gogs unreachable, treating all apps as not_installed: ${message}`,
      );
      return [];
    }
  }
}
