import { Module, forwardRef } from '@nestjs/common';
import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node';
import { CatalogModule } from '../catalog/catalog.module';
import { InstalledController } from './installed.controller';
import { SystemAppsController } from './system-apps.controller';
import { InstalledService } from './installed.service';
import { GitClient } from './git-client';
import { GitRemoteService } from './git-remote.service';
import { UserAppsRepoService } from './user-apps-repo.service';
import { FluxStatusService } from './flux-status.service';
import { SystemAppsService } from './system-apps.service';
import { LaunchUrlService } from './launch-url.service';

// Same kubeconfig selection FluxStatusService.onModuleInit already performs; as a
// factory it can be injected, which is what lets GitRemoteService be unit-tested
// without spying on a private method. Note this runs eagerly at module init, so
// Tier 1's closed-port KUBECONFIG fixture is still what keeps `loadFromDefault()`
// from throwing where no kubeconfig exists — unchanged behaviour, new location.
const customObjectsApiProvider = {
  provide: CustomObjectsApi,
  useFactory: (): CustomObjectsApi => {
    const kc = new KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
    else kc.loadFromDefault();
    return kc.makeApiClient(CustomObjectsApi);
  },
};

@Module({
  imports: [forwardRef(() => CatalogModule)],
  controllers: [InstalledController, SystemAppsController],
  providers: [
    InstalledService,
    customObjectsApiProvider,
    GitClient,
    GitRemoteService,
    UserAppsRepoService,
    FluxStatusService,
    SystemAppsService,
    LaunchUrlService,
  ],
  exports: [InstalledService],
})
export class InstalledModule {}
