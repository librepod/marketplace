import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InstalledModule } from '../installed/installed.module';
import { OnboardingStoreModule } from './onboarding-store.module';
import { CasdoorAdminService } from './casdoor-admin.service';
import { WgEasyService } from './wg-easy.service';
import { OnboardingService } from './onboarding.service';
import { OnboardingGuard } from './onboarding.guard';
import { BootstrapController } from './bootstrap.controller';
import { WireguardController } from './wireguard.controller';

@Module({
  // AuthModule: SessionService (the onboarding cookie's HMAC). InstalledModule:
  // InstalledService (the VPN install), OpenBaoClient (wg-easy's install answer) and
  // NodeAddressService (the endpoint suggestion). OnboardingStoreModule: the record.
  imports: [AuthModule, InstalledModule, OnboardingStoreModule],
  controllers: [BootstrapController, WireguardController],
  providers: [CasdoorAdminService, WgEasyService, OnboardingService, OnboardingGuard],
})
export class OnboardingModule {}
