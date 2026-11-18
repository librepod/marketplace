import { Module } from '@nestjs/common';
import { ApisApi } from '@kubernetes/client-node';
import { InstalledModule, loadKubeConfig } from '../installed/installed.module';
import { DeviceController } from './device.controller';
import { DeviceService } from './device.service';

@Module({
  imports: [InstalledModule],
  controllers: [DeviceController],
  providers: [
    DeviceService,
    {
      provide: ApisApi,
      useFactory: (): ApisApi => loadKubeConfig().makeApiClient(ApisApi),
    },
  ],
  exports: [DeviceService],
})
export class DeviceModule {}
