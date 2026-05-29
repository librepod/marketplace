import { cn } from "@/lib/utils"
import type { AppStatus } from "@librepod/shared"

const STATUS_CONFIG = {
  running:    { label: 'Running',    dot: 'bg-green-500' },
  installing: { label: 'Installing', dot: 'bg-yellow-400' },
  error:      { label: 'Error',      dot: 'bg-red-500' },
} as const

type InstalledStatus = Exclude<AppStatus, 'not_installed'>

export function StatusBadge({ status }: { status: InstalledStatus }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span
      role="status"
      className="flex items-center gap-1 rounded-full bg-background/80 px-2 py-0.5 text-xs font-medium shadow-sm"
    >
      <span className={cn('h-2 w-2 rounded-full', cfg.dot)} />
      {cfg.label}
    </span>
  )
}
