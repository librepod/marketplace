import { Injectable, NotFoundException, ConflictException, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Mutex } from 'async-mutex';
import * as crypto from 'node:crypto';
import { CatalogService } from '../catalog/catalog.service';
import { GogsService } from './gogs.service';
import { FluxStatusService } from './flux-status.service';
import type { CatalogApp, InstallResult } from '@librepod/shared';

@Injectable()
export class InstalledService {
  private readonly mutex = new Mutex();
  private readonly logger = new Logger(InstalledService.name);

  constructor(
    private readonly catalog: CatalogService,
    private readonly gogs: GogsService,
    private readonly flux: FluxStatusService,
    private readonly configService: ConfigService,
  ) {}

  async enrich(apps: CatalogApp[]): Promise<CatalogApp[]> {
    const installedNames = await this.gogs.getInstalledAppNames();
    const installedSet = new Set(installedNames);
    return Promise.all(
      apps.map(async (app) => {
        if (!installedSet.has(app.name)) {
          return { ...app, installedStatus: 'not_installed' as const };
        }
        const status = await this.flux.getStatusFor(app.name);
        return { ...app, installedStatus: status };
      }),
    );
  }

  async getInstalled(): Promise<CatalogApp[]> {
    const all = await this.enrich(this.catalog.findAll());
    return all.filter((app) => app.installedStatus !== 'not_installed');
  }

  private renderTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? `\${${key}}`);
  }

  private generateSecret(length: number): string {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
  }

  async install(appName: string): Promise<InstallResult> {
    return this.mutex.runExclusive(async () => {
      // 1. Validate app exists in catalog
      const app = this.catalog.findOne(appName);
      if (!app) throw new NotFoundException(`App "${appName}" not found in catalog`);
      if (!app.templates) throw new InternalServerErrorException(`App "${appName}" has no install templates`);

      // 2. Check not already installed
      const installed = await this.gogs.getInstalledAppNames();
      if (installed.includes(appName)) throw new ConflictException(`${app.displayName} is already installed`);

      // 3. Build variable substitution map
      const vars: Record<string, string> = {};
      vars.BASE_DOMAIN = this.configService.get<string>('BASE_DOMAIN', 'libre.pod');

      // Generate secrets
      if (app.secrets && app.secrets.length > 0) {
        for (const secret of app.secrets) {
          if (secret.generate) {
            vars[secret.name] = this.generateSecret(secret.generate.length);
          }
        }
      }

      // 4. Render and write template files (app files FIRST per Pitfall 3)
      const basePath = `apps/${appName}`;
      await this.gogs.createFile(
        `${basePath}/source.yaml`,
        this.renderTemplate(app.templates.source, vars),
        `install ${appName}: add source`,
      );
      await this.gogs.createFile(
        `${basePath}/release.yaml`,
        this.renderTemplate(app.templates.release, vars),
        `install ${appName}: add release`,
      );
      if (app.templates.secret) {
        await this.gogs.createFile(
          `${basePath}/secret.yaml`,
          this.renderTemplate(app.templates.secret, vars),
          `install ${appName}: add secret`,
        );
      }
      await this.gogs.createFile(
        `${basePath}/kustomization.yaml`,
        this.renderTemplate(app.templates.kustomization, vars),
        `install ${appName}: add kustomization`,
      );

      // 5. Update root kustomization.yaml LAST (per Pitfall 3)
      await this.gogs.addToRootKustomization(appName);

      return { success: true, message: `${app.displayName} is being deployed` };
    });
  }

  async uninstall(appName: string): Promise<InstallResult> {
    return this.mutex.runExclusive(async () => {
      // 1. Validate app exists
      const app = this.catalog.findOne(appName);
      if (!app) throw new NotFoundException(`App "${appName}" not found in catalog`);

      // 2. Check is installed
      const installed = await this.gogs.getInstalledAppNames();
      if (!installed.includes(appName)) throw new ConflictException(`${app.displayName} is not installed`);

      // 3. Remove from root kustomization FIRST
      await this.gogs.removeFromRootKustomization(appName);

      return { success: true, message: `${app.displayName} has been removed` };
    });
  }
}
