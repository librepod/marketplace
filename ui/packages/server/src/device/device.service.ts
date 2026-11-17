import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiException,
  ApisApi,
  CoreV1Api,
  CustomObjectsApi,
  PatchStrategy,
  setHeaderOptions,
} from '@kubernetes/client-node';
import type {
  DeviceInfo,
  DeviceMetrics,
  DeviceSection,
} from '@librepod/shared';
import { isTimeZone } from './device-input';
import {
  NUMBER_FIELD,
  nextNumber,
  toDeviceView,
  type RawDevice,
} from './device-view';
import { parseQuantity } from './quantity';

const DEVICE_GROUP = 'os.librepod.org';
// Versions this UI can read, newest first; the served one is picked by discovery.
const DEVICE_VERSIONS = ['v1beta1', 'v1alpha1'];

type Fetched =
  | { os: 'absent' }
  | { os: 'starting' }
  | { os: 'present'; version: string; raw: RawDevice };

@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);

  constructor(
    private readonly objects: CustomObjectsApi,
    private readonly core: CoreV1Api,
    private readonly apis: ApisApi,
    private readonly config: ConfigService,
  ) {}

  private unavailable(err: unknown): never {
    this.logger.warn(`Device read failed: ${(err as Error).message}`);
    throw new ServiceUnavailableException(
      "Couldn't reach your LibrePod's system service. Try again in a minute.",
    );
  }

  protected async fetch(): Promise<Fetched> {
    try {
      const list = await this.apis.getAPIVersions();
      const group = list.groups.find((g) => g.name === DEVICE_GROUP);
      if (!group) return { os: 'absent' };
      const served = group.versions.map((v) => v.version);
      const version = DEVICE_VERSIONS.find((v) => served.includes(v));
      // A served group at a version we can't read is NOT "no OS": hiding everything
      // would let onboarding mint a random setup code over the sticker's.
      if (!version)
        throw new Error(
          `${DEVICE_GROUP} is served at ${served.join(', ')}; this UI reads ${DEVICE_VERSIONS.join(', ')}`,
        );
      const res = (await this.objects.listClusterCustomObject({
        group: DEVICE_GROUP,
        version,
        plural: 'devices',
      })) as { items?: RawDevice[] };
      const items = [...(res.items ?? [])].sort((a, b) =>
        a.metadata.name.localeCompare(b.metadata.name),
      );
      if (items.length === 0) return { os: 'starting' };
      const mine = this.config.get<string>('NODE_NAME');
      return {
        os: 'present',
        version,
        raw: items.find((d) => d.metadata.name === mine) ?? items[0],
      };
    } catch (err) {
      return this.unavailable(err);
    }
  }

  private async metrics(node: string): Promise<DeviceMetrics | null> {
    try {
      const [usage, n] = await Promise.all([
        this.objects.getClusterCustomObject({
          group: 'metrics.k8s.io',
          version: 'v1beta1',
          plural: 'nodes',
          name: node,
        }) as Promise<{ usage: { cpu: string; memory: string } }>,
        this.core.readNode({ name: node }),
      ]);
      const cap = n.status?.capacity ?? {};
      const cpuTotal = parseQuantity(cap.cpu);
      return {
        cpuPercent: (parseQuantity(usage.usage.cpu) / cpuTotal) * 100,
        memoryUsedBytes: parseQuantity(usage.usage.memory),
        memoryTotalBytes: parseQuantity(cap.memory),
      };
    } catch {
      return null;
    }
  }

  async read(): Promise<DeviceInfo> {
    const f = await this.fetch();
    if (f.os !== 'present') return { os: f.os };
    const metrics = await this.metrics(f.raw.metadata.name);
    return { os: 'present', device: toDeviceView(f.raw, metrics, Date.now()) };
  }

  async setupCodeHash(): Promise<string | null> {
    const f = await this.fetch();
    if (f.os !== 'present') return null;
    const h = f.raw.status?.setupCodeHash;
    return typeof h === 'string' && h ? h : null;
  }

  /**
   * Merge-patch one whole spec section with the next answer number, guarded by
   * resourceVersion so two tabs can't both send the same number. Retries once on 409.
   */
  async write(section: DeviceSection, payload: object): Promise<DeviceInfo> {
    for (let attempt = 0; ; attempt++) {
      const f = await this.fetch();
      if (f.os !== 'present')
        throw new ConflictException("LibrePod OS isn't reporting yet");
      this.assertWritable(f.raw, section);
      try {
        await this.objects.patchClusterCustomObject(
          {
            group: DEVICE_GROUP,
            version: f.version,
            plural: 'devices',
            name: f.raw.metadata.name,
            body: {
              metadata: { resourceVersion: f.raw.metadata.resourceVersion },
              spec: {
                [section]: {
                  [NUMBER_FIELD[section]]: nextNumber(f.raw, section),
                  ...payload,
                },
              },
            },
          },
          setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
        );
        return this.read();
      } catch (err) {
        if (err instanceof ApiException && err.code === 409) {
          if (attempt === 0) continue;
          throw new ConflictException('Changed elsewhere, try again');
        }
        return this.unavailable(err);
      }
    }
  }

  /**
   * Onboarding's invisible default: record the browser's time zone as the device's
   * first `updates` answer, only if nobody ever answered. Channel and auto come from
   * what the device reports so the UI never overrides the OS defaults. Never throws.
   */
  async seedTimezone(tz: unknown): Promise<void> {
    try {
      if (!isTimeZone(tz)) return;
      const f = await this.fetch();
      if (f.os !== 'present') return;
      const handled = (
        f.raw.status?.handled as Record<string, unknown> | undefined
      )?.updates;
      if ((typeof handled === 'number' && handled > 0) || f.raw.spec?.updates)
        return;
      const view = toDeviceView(f.raw, null, Date.now());
      await this.write('updates', {
        channel: view.update?.settings?.channel ?? 'stable',
        auto: view.update?.settings?.auto ?? true,
        timezone: tz,
      });
    } catch (err) {
      this.logger.warn(
        `could not seed the time zone: ${(err as Error).message}`,
      );
    }
  }

  private assertWritable(raw: RawDevice, section: DeviceSection): void {
    if (section !== 'install' && section !== 'power') return;
    const view = toDeviceView(raw, null, Date.now());
    if (!view.reporting) {
      const since = view.reportedAt ?? 'ever';
      throw new ConflictException(
        `Your LibrePod hasn't reported since ${since}; try again when it's back.`,
      );
    }
    if (section === 'power' && view.update?.state === 'installing') {
      throw new ConflictException('an update is installing');
    }
  }
}
