import { Module, forwardRef } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { InstalledController } from './installed.controller';
import { SystemAppsController } from './system-apps.controller';
import { InstalledService } from './installed.service';
import { GogsService } from './gogs.service';
import { FluxStatusService } from './flux-status.service';
import { SystemAppsService } from './system-apps.service';
import { LaunchUrlService } from './launch-url.service';

@Module({
  imports: [forwardRef(() => CatalogModule)],
  controllers: [InstalledController, SystemAppsController],
  providers: [InstalledService, GogsService, FluxStatusService, SystemAppsService, LaunchUrlService],
  exports: [InstalledService],
})
export class InstalledModule {}
