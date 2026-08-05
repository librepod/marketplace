import { Injectable, NotFoundException, ConflictException, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Mutex } from 'async-mutex';
import * as crypto from 'node:crypto';
import { CatalogService } from '../catalog/catalog.service';
import { GogsService } from './gogs.service';
import { FluxStatusService } from './flux-status.service';
import { SystemAppsService } from './system-apps.service';
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
    private readonly systemApps: SystemAppsService,
  ) {}

  async enrich(apps: CatalogApp[]): Promise<CatalogApp[]> {
    const [installedNames, systemMap] = await Promise.all([
      this.gogs.getInstalledAppNames(),
      this.systemApps.getSystemApps(),
    ]);
    const installedSet = new Set(installedNames);
    return Promise.all(
      apps.map(async (app) => {
        // System classification wins: a managed app's status comes from its
        // platform Flux object (by name), never the Gogs "installed?" check —
        // this is what stops the forever-"Installing" badge for apps like
        // frp-operator that are both system-managed and present in user-apps.
        const systemKustomization = systemMap.get(app.name);
        if (systemKustomization) {
          const status = await this.flux.getStatusFor(app.name, { systemKustomization });
          return { ...app, system: true, installedStatus: status };
        }
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
    return all.filter(
      (app) => app.installedStatus !== 'not_installed' && !app.system,
    );
  }

  async getSystemApps(): Promise<CatalogApp[]> {
    const all = await this.enrich(this.catalog.findAll());
    return all.filter((app) => app.system);
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
      // Managed apps are read-only platform components; guard BEFORE the
      // templates check so a templates-less managed app still yields 409
      // (not a 500 templates error).
      if (await this.systemApps.isSystem(appName)) {
        throw new ConflictException(
          `${app.displayName} is managed by the platform and cannot be installed`,
        );
      }
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
      if (await this.systemApps.isSystem(appName)) {
        throw new ConflictException(
          `${app.displayName} is managed by the platform and cannot be uninstalled`,
        );
      }

      // 2. Check is installed
      const installed = await this.gogs.getInstalledAppNames();
      if (!installed.includes(appName)) throw new ConflictException(`${app.displayName} is not installed`);

      // 3. Remove from root kustomization FIRST
      await this.gogs.removeFromRootKustomization(appName);

      return { success: true, message: `${app.displayName} has been removed` };
    });
  }
}
