import { cn } from "@/lib/utils"
import type { AppStatus } from "@librepod/shared"

// The one place the operational status colours live. These are the canonical
// signal hues from the design system (design.json: status-running #22c55e,
// status-installing #facc15, status-error #ef4444) — the only saturated colour
// the Workbench spends, and it must read the same on every surface. Anything
// that draws a status dot (the badge, the device summary, the first-run health
// line) reads from here so there is a single source of truth.
export const STATUS_DOT: Record<Exclude<AppStatus, 'not_installed'>, string> = {
  running:    'bg-green-500',
  installing: 'bg-yellow-400',
  error:      'bg-red-500',
}

const STATUS_CONFIG = {
  running:    { label: 'Running',    dot: STATUS_DOT.running },
  installing: { label: 'Installing', dot: STATUS_DOT.installing },
  error:      { label: 'Error',      dot: STATUS_DOT.error },
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
