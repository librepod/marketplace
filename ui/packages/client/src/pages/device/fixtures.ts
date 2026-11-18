import type { DeviceView } from "@librepod/shared"

/** A healthy, reporting Device view; tests override what they care about. */
export function deviceView(over: Partial<DeviceView> = {}): DeviceView {
  return {
    name: "node-a",
    reportedAt: new Date().toISOString(),
    reporting: true,
    version: "0.5.0",
    rootDisk: { sizeBytes: 32e9, usedBytes: 9.8e9 },
    dataDisk: { present: true, sizeBytes: 480e9, usedBytes: 412e9 },
    update: { state: "up-to-date", current: "0.5.0", settings: { channel: "stable", auto: true, timezone: "Europe/Minsk" } },
    sshKeys: [],
    rejected: {},
    pending: { updates: false, install: false, power: false, sshKeys: false },
    metrics: { cpuPercent: 12.4, memoryUsedBytes: 5.2e9, memoryTotalBytes: 16e9 },
    ...over,
  }
}
