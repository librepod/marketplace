import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CatalogApp } from './catalog.types';

@Controller('apps')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  findAll(): CatalogApp[] {
    return this.catalogService.findAll();
  }

  @Get(':name')
  findOne(@Param('name') name: string): CatalogApp {
    const app = this.catalogService.findOne(name);
    if (!app) {
      throw new NotFoundException(`App "${name}" not found`);
    }
    return app;
  }
}
