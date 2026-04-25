import { Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { GogsService } from './gogs.service';
import { FluxStatusService } from './flux-status.service';
import type { CatalogApp } from '@librepod/shared';

@Injectable()
export class InstalledService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly gogs: GogsService,
    private readonly flux: FluxStatusService,
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
}
