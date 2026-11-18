import type {
  DeviceSection,
  DeviceView,
  DeviceMetrics,
  DeviceUpdateStatus,
  DeviceDisk,
  DeviceDataDisk,
} from '@librepod/shared';

export interface RawDevice {
  metadata: { name: string; resourceVersion?: string };
  spec?: Partial<Record<DeviceSection, Record<string, unknown>>>;
  status?: Record<string, unknown>;
}

export const REPORTING_WINDOW_MS = 10 * 60_000;
export const NUMBER_FIELD: Record<DeviceSection, 'rev' | 'id'> = {
  updates: 'rev',
  sshKeys: 'rev',
  install: 'id',
  power: 'id',
};
const SECTIONS = Object.keys(NUMBER_FIELD) as DeviceSection[];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function handled(raw: RawDevice, s: DeviceSection): number {
  const h = raw.status?.handled;
  return isObj(h) ? num(h[s]) : 0;
}
function specNumber(raw: RawDevice, s: DeviceSection): number {
  return num(raw.spec?.[s]?.[NUMBER_FIELD[s]]);
}

/** Next answer number: never reuse one, even after a rollback leaves spec below handled. */
export function nextNumber(raw: RawDevice, s: DeviceSection): number {
  return Math.max(specNumber(raw, s), handled(raw, s)) + 1;
}

export function toDeviceView(
  raw: RawDevice,
  metrics: DeviceMetrics | null,
  now: number,
): DeviceView {
  const st = raw.status ?? {};
  const sys = isObj(st.system) ? st.system : {};
  const reportedAt = typeof st.updated === 'string' ? st.updated : null;
  const t = reportedAt ? Date.parse(reportedAt) : NaN;
  const rejected: DeviceView['rejected'] = {};
  if (isObj(st.rejected)) {
    for (const s of SECTIONS)
      if (typeof st.rejected[s] === 'string') rejected[s] = st.rejected[s];
  }
  return {
    name: raw.metadata.name,
    reportedAt,
    reporting: Number.isFinite(t) && now - t <= REPORTING_WINDOW_MS,
    version: typeof sys.version === 'string' ? sys.version : null,
    rootDisk: isObj(sys.rootDisk)
      ? (sys.rootDisk as unknown as DeviceDisk)
      : null,
    dataDisk: isObj(sys.dataDisk)
      ? (sys.dataDisk as unknown as DeviceDataDisk)
      : null,
    update: isObj(st.update) ? (st.update as DeviceUpdateStatus) : null,
    sshKeys: Array.isArray(st.sshKeys)
      ? st.sshKeys.filter((k): k is string => typeof k === 'string')
      : [],
    rejected,
    pending: Object.fromEntries(
      SECTIONS.map((s) => [s, specNumber(raw, s) > handled(raw, s)]),
    ) as Record<DeviceSection, boolean>,
    metrics,
  };
}
