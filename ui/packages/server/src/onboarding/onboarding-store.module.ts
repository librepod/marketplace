import { Module } from '@nestjs/common';
import { InstalledModule } from '../installed/installed.module';
import { OnboardingStore } from './onboarding-store';

/** Its own module so AuthModule (the SSO callback's finish hook) and OnboardingModule
 * (which imports AuthModule for SessionService) share one store without a cycle. */
@Module({
  // InstalledModule exports OpenBaoClient: one client, one cached OpenBao login.
  imports: [InstalledModule],
  providers: [OnboardingStore],
  exports: [OnboardingStore],
})
export class OnboardingStoreModule {}
