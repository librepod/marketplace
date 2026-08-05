import { Controller, Get } from '@nestjs/common';
import { InstalledService } from './installed.service';
import type { CatalogApp } from '@librepod/shared';

@Controller('system-apps')
export class SystemAppsController {
  constructor(private readonly installedService: InstalledService) {}

  @Get()
  async findAll(): Promise<CatalogApp[]> {
    return this.installedService.getSystemApps();
  }
}
