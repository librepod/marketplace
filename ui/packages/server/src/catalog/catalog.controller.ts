import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { InstalledService } from '../installed/installed.service';
import { CatalogApp } from './catalog.types';

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
}
