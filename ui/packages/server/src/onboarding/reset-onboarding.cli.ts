import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { ApisApi, CoreV1Api, CustomObjectsApi } from '@kubernetes/client-node';
import { DeviceService } from '../device/device.service';
import { loadKubeConfig } from '../installed/installed.module';
import { OpenBaoClient } from '../installed/openbao.client';
import { OnboardingStore } from './onboarding-store';
import { runReset } from './reset-onboarding';

// `kubectl -n marketplace-ui exec deploy/marketplace-ui -- reset-onboarding` runs this
// (via /usr/local/bin/reset-onboarding). It signs in to OpenBao the way the server
// does — the pod's ServiceAccount, Kubernetes auth — with the container's env. The
// server caches the record for at most 5 s, so the reset lands without a restart.
const config = new ConfigService();
const kc = loadKubeConfig();
const device = new DeviceService(
  kc.makeApiClient(CustomObjectsApi),
  kc.makeApiClient(CoreV1Api),
  kc.makeApiClient(ApisApi),
  config,
);
void runReset(
  new OnboardingStore(new OpenBaoClient(config), config, device),
  console,
).then((code) => process.exit(code));
