import { AlertTriangle } from "lucide-react"
import { Navigate } from "react-router-dom"
import type { DeviceView } from "@librepod/shared"
import { ErrorBlock } from "@/components/ErrorBlock"
import { STATUS_DOT } from "@/components/StatusBadge"
import { Skeleton } from "@/components/ui/skeleton"
import { useDevice } from "@/hooks/useDevice"
import { PowerControls } from "./device/PowerControls"
import { UpdatesCard } from "./device/UpdatesCard"
import { UpdateSettingsCard } from "./device/UpdateSettingsCard"
import { SshKeysCard } from "./device/SshKeysCard"
import { HealthTiles } from "./device/HealthTiles"
import { formatAgo } from "./device/format"

function Banner({ tone, children }: { tone: "amber" | "red"; children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className={
        tone === "red"
          ? "flex items-center gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"
          : "flex items-center gap-2 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
      }
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  )
}

function Header({ device }: { device: DeviceView }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold">Your LibrePod</h2>
        <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
          <span className={`size-2 rounded-full ${device.reporting ? STATUS_DOT.running : STATUS_DOT.installing}`} aria-hidden />
          <span>
            LibrePod OS {device.version ?? "—"}
            {device.reportedAt && ` · reported ${formatAgo(device.reportedAt, Date.now())}`}
          </span>
        </p>
      </div>
      <PowerControls device={device} />
    </div>
  )
}

export function DevicePage() {
  const { data, isPending, refetch } = useDevice({ pollMs: 5000 })

  if (isPending) return <Skeleton className="h-40 w-full" />
  if (!data) return <ErrorBlock onRetry={refetch} />
  if (data.os === "absent") return <Navigate to="/" replace />
  if (data.os === "starting") {
    return <p className="mt-12 text-center text-muted-foreground">Your LibrePod is still starting up. This page will fill in by itself.</p>
  }
  const { device } = data
  return (
    <div className="space-y-6">
      <Header device={device} />
      {!device.reporting && (
        <Banner tone="amber">
          Your LibrePod hasn't reported since {device.reportedAt ? new Date(device.reportedAt).toLocaleString() : "it started"}.
          Settings you change now apply when it's back.
        </Banner>
      )}
      {device.dataDisk && !device.dataDisk.present && (
        <Banner tone="red">The data disk is missing.</Banner>
      )}
      <HealthTiles device={device} />
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <UpdatesCard device={device} />
        <UpdateSettingsCard device={device} />
      </div>
      <SshKeysCard device={device} />
    </div>
  )
}
