import {
  Injectable,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Mutex } from 'async-mutex';
import * as crypto from 'node:crypto';
import { CatalogService } from '../catalog/catalog.service';
import { UserAppsRepoService } from './user-apps-repo.service';
import { FluxStatusService } from './flux-status.service';
import { SystemAppsService } from './system-apps.service';
import { LaunchUrlService } from './launch-url.service';
import { resolveSettings } from './install-settings';
import { OpenBaoClient, OpenBaoMisconfiguredError, OpenBaoUnavailableError } from './openbao.client';
import { LegacySecretMirror } from './legacy-secret-mirror';
import type { CatalogApp, InstallResult } from '@librepod/shared';

@Injectable()
export class InstalledService {
  private readonly mutex = new Mutex();
  private readonly logger = new Logger(InstalledService.name);

  constructor(
    private readonly catalog: CatalogService,
    private readonly repo: UserAppsRepoService,
    private readonly flux: FluxStatusService,
    private readonly configService: ConfigService,
    private readonly systemApps: SystemAppsService,
    private readonly launchUrl: LaunchUrlService,
    private readonly openBao: OpenBaoClient,
    private readonly legacyMirror: LegacySecretMirror,
  ) {}

  async enrich(apps: CatalogApp[]): Promise<CatalogApp[]> {
    const [installedNames, systemMap] = await Promise.all([
      this.repo.listInstalledApps(),
      this.systemApps.getSystemApps(),
    ]);
    const installedSet = new Set(installedNames);

    // Merge the launch resolution ({}/{url}/{launchable}) onto an app, stamping
    // only present fields (mirrors the launchUrl/launchable tri-state contract).
    const withLaunch = async (app: CatalogApp): Promise<CatalogApp> => {
      const res = await this.launchUrl.resolve(app.name);
      const extra: Partial<CatalogApp> = {};
      if (res.url !== undefined) extra.launchUrl = res.url;
      if (res.launchable !== undefined) extra.launchable = res.launchable;
      return { ...app, ...extra };
    };

    return Promise.all(
      apps.map(async (app) => {
        // System classification wins: a managed app's status comes from its
        // platform Flux object (by name), never the app-store "installed?" check —
        // this is what stops the forever-"Installing" badge for apps like
        // frp-operator that are both system-managed and present in user-apps.
        const systemKustomization = systemMap.get(app.name);
        if (systemKustomization) {
          const status = await this.flux.getStatusFor(app.name, { systemKustomization });
          return withLaunch({ ...app, system: true, installedStatus: status });
        }
        if (!installedSet.has(app.name)) {
          return { ...app, installedStatus: 'not_installed' as const };
        }
        const status = await this.flux.getStatusFor(app.name);
        return withLaunch({ ...app, installedStatus: status });
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

  /**
   * Maps a settings-store failure (from the read or the write below) to the one user-facing
   * answer: 503 "try again" when the store may recover, 500 without it when it won't. One
   * helper so the two call sites cannot drift apart.
   */
  private throwSettingsStoreError(err: unknown, appName: string): never {
    if (err instanceof OpenBaoUnavailableError) {
      this.logger.warn(`settings store unavailable while installing ${appName}: ${err.message}`);
      throw new ServiceUnavailableException("Couldn't save the settings right now. Try again in a minute.");
    }
    if (err instanceof OpenBaoMisconfiguredError) {
      this.logger.error(`settings store misconfigured, cannot install ${appName}: ${err.message}`);
      throw new InternalServerErrorException(
        "Couldn't save the settings: the settings store isn't set up correctly. Trying again won't help.",
      );
    }
    throw err;
  }

  async install(appName: string, body?: unknown): Promise<InstallResult> {
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
      const installed = await this.repo.listInstalledApps();
      if (installed.includes(appName)) throw new ConflictException(`${app.displayName} is already installed`);

      // 3. Install questions + custom variables → OpenBao, BEFORE the Gogs commit, so
      // the app's ExternalSecret finds its entry as soon as Flux applies the app.
      // Values never enter the Gogs repo or ${VAR} substitution. Apps without
      // `settings` skip this entirely (and ignore any body). The stored entry is
      // read first so a reinstall regenerates nothing: generated questions reuse
      // what the last install wrote (NFS volumes survive, so a DB password must too).
      if (app.settings) {
        let stored: Record<string, string> | null = null;
        try {
          stored = await this.openBao.readAppSettings(appName);
        } catch (err) {
          this.throwSettingsStoreError(err, appName);
        }
        const resolved = resolveSettings(app.settings, body, stored);
        if (!resolved.ok) {
          throw new BadRequestException({ message: 'Some settings need attention', errors: resolved.errors });
        }
        try {
          await this.openBao.writeAppSettings(appName, resolved.values);
        } catch (err) {
          this.throwSettingsStoreError(err, appName);
        }
      }

      // 4. Build variable substitution map
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

      // 5. Render every file and write them as ONE commit. Ordering no longer
      // matters ("Pitfall 3" was about the root kustomization.yaml naming an
      // app dir before its files existed) — atomicity now comes from the commit,
      // and Flux auto-generates its kustomization from the tree.
      const files: Record<string, string> = {
        'source.yaml': this.renderTemplate(app.templates.source, vars),
        'release.yaml': this.renderTemplate(app.templates.release, vars),
        'kustomization.yaml': this.renderTemplate(app.templates.kustomization, vars),
      };
      if (app.templates.secret) {
        files['secret.yaml'] = this.renderTemplate(app.templates.secret, vars);
      }
      await this.repo.writeApp(appName, files);

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
      const installed = await this.repo.listInstalledApps();
      if (!installed.includes(appName)) throw new ConflictException(`${app.displayName} is not installed`);

      // Snapshot legacy secret values into OpenBao BEFORE deleting the Gogs
      // files: after removeApp the values exist nowhere (the flux-system
      // Secret is pruned with the repo path), and a reinstall on surviving
      // NFS data must reuse them. Best-effort: a failure logs and proceeds.
      await this.legacyMirror.snapshotApp(appName).catch((err: unknown) =>
        this.logger.warn(`legacy secret snapshot failed for ${appName}: ${(err as Error).message}`),
      );

      // 3. Delete the app's whole directory — one commit. Unlike the old
      // root-kustomization edit this really removes the files, so a later
      // reinstall starts clean and Flux's auto-generated build cannot
      // resurrect the app.
      await this.repo.removeApp(appName);

      return { success: true, message: `${app.displayName} has been removed` };
    });
  }
}
