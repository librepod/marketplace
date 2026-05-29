import { Module, forwardRef } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { InstalledController } from './installed.controller';
import { InstalledService } from './installed.service';
import { GogsService } from './gogs.service';
import { FluxStatusService } from './flux-status.service';

@Module({
  imports: [forwardRef(() => CatalogModule)],
  controllers: [InstalledController],
  providers: [InstalledService, GogsService, FluxStatusService],
  exports: [InstalledService],
})
export class InstalledModule {}
