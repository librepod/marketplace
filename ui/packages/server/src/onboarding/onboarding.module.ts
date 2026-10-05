import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CasdoorAdminService } from './casdoor-admin.service';
import { DeviceAdminStore } from './device-admin.store';
import { WgEasyService } from './wg-easy.service';
import { OnboardingGuard } from './onboarding.guard';
import { BootstrapController } from './bootstrap.controller';
import { WireguardController } from './wireguard.controller';

@Module({
  imports: [AuthModule], // SessionService (HMAC signing for the onboarding cookie)
  controllers: [BootstrapController, WireguardController],
  providers: [CasdoorAdminService, WgEasyService, DeviceAdminStore, OnboardingGuard],
})
export class OnboardingModule {}
