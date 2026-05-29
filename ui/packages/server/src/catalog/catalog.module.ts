import { Module, forwardRef } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { InstalledModule } from '../installed/installed.module';

@Module({
  imports: [forwardRef(() => InstalledModule)],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
