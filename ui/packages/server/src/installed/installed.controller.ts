import { Controller, Get } from '@nestjs/common';
import { InstalledService } from './installed.service';
import type { CatalogApp } from '@librepod/shared';

@Controller('installed')
export class InstalledController {
  constructor(private readonly installedService: InstalledService) {}

  @Get()
  async findInstalled(): Promise<CatalogApp[]> {
    return this.installedService.getInstalled();
  }
}
