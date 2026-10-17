import { Module, forwardRef } from '@nestjs/common';
import { KubeConfig, CustomObjectsApi, CoreV1Api } from '@kubernetes/client-node';
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
import { OpenBaoClient } from './openbao.client';
import { LegacySecretMirror } from './legacy-secret-mirror';
import { NodeAddressService } from './node-address.service';

// Same kubeconfig selection FluxStatusService.onModuleInit already performs; as
// factories the API clients can be injected, which is what lets GitRemoteService
// and NodeAddressService be unit-tested without spying on a private method. Note
// these run eagerly at module init, so Tier 1's closed-port KUBECONFIG fixture is
// still what keeps `loadFromDefault()` from throwing where no kubeconfig exists.
function loadKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();
  return kc;
}

const customObjectsApiProvider = {
  provide: CustomObjectsApi,
  useFactory: (): CustomObjectsApi => loadKubeConfig().makeApiClient(CustomObjectsApi),
};

const coreV1ApiProvider = {
  provide: CoreV1Api,
  useFactory: (): CoreV1Api => loadKubeConfig().makeApiClient(CoreV1Api),
};

@Module({
  imports: [forwardRef(() => CatalogModule)],
  controllers: [InstalledController, SystemAppsController],
  providers: [
    InstalledService,
    customObjectsApiProvider,
    coreV1ApiProvider,
    GitClient,
    GitRemoteService,
    UserAppsRepoService,
    FluxStatusService,
    SystemAppsService,
    LaunchUrlService,
    OpenBaoClient,
    LegacySecretMirror,
    NodeAddressService,
  ],
  // OpenBaoClient and NodeAddressService also serve first-run onboarding
  // (src/onboarding): one OpenBao login, one node lookup.
  exports: [InstalledService, OpenBaoClient, NodeAddressService],
})
export class InstalledModule {}
