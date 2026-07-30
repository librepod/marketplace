import { Controller, Get, Post, Param, NotFoundException, HttpCode } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { InstalledService } from '../installed/installed.service';
import { CatalogApp } from './catalog.types';
import type { InstallResult } from '@librepod/shared';

@Controller('apps')
export class CatalogController {
  constructor(
    private readonly catalogService: CatalogService,
    private readonly installedService: InstalledService,
  ) {}

  @Get()
  async findAll(): Promise<CatalogApp[]> {
    const apps = this.catalogService.findAll();
    return this.installedService.enrich(apps);
  }

  @Get(':name')
  async findOne(@Param('name') name: string): Promise<CatalogApp> {
    const app = this.catalogService.findOne(name);
    if (!app) {
      throw new NotFoundException(`App "${name}" not found`);
    }
    const enriched = await this.installedService.enrich([app]);
    return enriched[0];
  }

  @Post(':name/install')
  @HttpCode(200)
  async install(@Param('name') name: string): Promise<InstallResult> {
    return this.installedService.install(name);
  }

  @Post(':name/uninstall')
  @HttpCode(200)
  async uninstall(@Param('name') name: string): Promise<InstallResult> {
    return this.installedService.uninstall(name);
  }
}
