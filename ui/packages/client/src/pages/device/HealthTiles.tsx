import type { DeviceView } from "@librepod/shared"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { formatBytes } from "./format"

// A disk bar turns amber at this share used.
const DISK_WARN = 0.85

function Tile({ label, value, detail, ratio, danger }: {
  label: string; value: string; detail?: string; ratio?: number | null; danger?: boolean
}) {
  return (
    <Card size="sm" className="px-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-semibold", danger && "text-destructive")}>{value}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      {ratio != null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full", ratio >= DISK_WARN ? "bg-amber-500" : "bg-primary")}
            style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
          />
        </div>
      )}
    </Card>
  )
}

const used = (d: { sizeBytes?: number; usedBytes?: number }) =>
  d.sizeBytes ? `${formatBytes(d.usedBytes ?? 0)} of ${formatBytes(d.sizeBytes)}` : undefined
const share = (d: { sizeBytes?: number; usedBytes?: number }) =>
  d.sizeBytes ? (d.usedBytes ?? 0) / d.sizeBytes : null
// No size reported (older LibrePod OS) reads "—", never a misleading "0%".
const percent = (d: { sizeBytes?: number; usedBytes?: number } | null) => {
  const s = d ? share(d) : null
  return s === null ? "—" : `${Math.round(s * 100)}%`
}

export function HealthTiles({ device }: { device: DeviceView }) {
  const { metrics, rootDisk, dataDisk } = device
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile label="CPU" value={metrics ? `${Math.round(metrics.cpuPercent)}%` : "—"} />
      <Tile
        label="Memory"
        value={metrics ? `${Math.round((metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100)}%` : "—"}
        detail={metrics ? `${formatBytes(metrics.memoryUsedBytes)} of ${formatBytes(metrics.memoryTotalBytes)}` : undefined}
      />
      <Tile
        label="System disk"
        value={percent(rootDisk)}
        detail={rootDisk ? used(rootDisk) : undefined}
        ratio={rootDisk ? share(rootDisk) : null}
      />
      {dataDisk && !dataDisk.present ? (
        <Tile label="Data disk" value="Missing" danger />
      ) : (
        <Tile
          label="Data disk"
          value={percent(dataDisk)}
          detail={dataDisk ? used(dataDisk) : undefined}
          ratio={dataDisk ? share(dataDisk) : null}
        />
      )}
    </div>
  )
}
