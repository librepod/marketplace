import React from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Server, Archive, RefreshCw, Users, ArrowRight } from "lucide-react"
import { apiFetch } from "@/lib/api"
import type { CatalogApp } from "@librepod/shared"
import { LaunchTile } from "@/components/LaunchTile"
import { AppCardSkeleton } from "@/components/AppCardSkeleton"
import { ErrorBlock } from "@/components/ErrorBlock"
import { SoonTag } from "@/components/SoonTag"
import { STATUS_DOT } from "@/components/StatusBadge"
import { useConfig } from "@/hooks/useConfig"
import { cn } from "@/lib/utils"

const GRID_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
  gap: 20,
}

export function MyAppsPage() {
  const { data: config } = useConfig()
  const { isPending, isError, data, refetch } = useQuery<CatalogApp[]>({
    queryKey: ["installed"],
    queryFn: async () => {
      const res = await apiFetch("/api/installed")
      if (!res.ok) throw new Error("Failed to fetch installed apps")
      return res.json()
    },
    retry: 0,
    // Mirror the catalog: poll while any installed app is still installing, so
    // My Apps reflects the installing → running transition without a manual refresh.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((a) => a.installedStatus === "installing")
        ? 3000
        : false,
  })

  const apps = data ?? []
  const hasApps = !isPending && !isError && apps.length > 0

  return (
    <>
      <h1 className="sr-only">My Apps</h1>

      {isPending && (
        <>
          <DeviceSummarySkeleton />
          <div style={GRID_STYLE}>
            {Array.from({ length: 4 }).map((_, i) => (
              <AppCardSkeleton key={i} />
            ))}
          </div>
        </>
      )}

      {!isPending && isError && <ErrorBlock onRetry={refetch} />}

      {!isPending && !isError && apps.length === 0 && (
        <FirstRun baseDomain={config?.baseDomain} />
      )}

      {hasApps && (
        <>
          <DeviceSummary apps={apps} baseDomain={config?.baseDomain} />

          <section aria-labelledby="apps-heading" className="mt-8">
            <h2 id="apps-heading" className="mb-4 text-sm font-medium text-muted-foreground">
              Your apps
            </h2>
            <div style={GRID_STYLE}>
              {apps.map((app) => (
                <LaunchTile key={app.name} app={app} baseDomain={config?.baseDomain} />
              ))}
            </div>
          </section>

          <ControlsPanel />
        </>
      )}
    </>
  )
}

/* ── Device summary ─────────────────────────────────────────────────────── */

// The honest device header. Three counts carry the Workbench's only operational
// colours — a dot lit only when that state has apps in it — beside the device
// address. Zero-count states dim rather than shout, so a healthy device reads
// calm and an erroring one draws the eye to the one dot that matters.
function DeviceSummary({ apps, baseDomain }: { apps: CatalogApp[]; baseDomain?: string }) {
  const running = apps.filter((a) => a.installedStatus === "running").length
  const installing = apps.filter((a) => a.installedStatus === "installing").length
  const errored = apps.filter((a) => a.installedStatus === "error").length

  return (
    <section
      aria-label="Device status"
      className="rounded-xl bg-card p-5 ring-1 ring-foreground/10"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-foreground/8 text-foreground">
            <Server className="size-[18px]" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium leading-tight">Your LibrePod</p>
            <p className="truncate text-xs text-muted-foreground">
              {baseDomain ?? (
                <span className="inline-block h-3 w-24 animate-pulse rounded-sm bg-muted-foreground/20" />
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-5 sm:gap-6">
          <Stat dot="running" active={running > 0} value={running} label="Running" />
          <Stat dot="installing" active={installing > 0} value={installing} label="Setting up" />
          <Stat dot="error" active={errored > 0} value={errored} label="Attention" />
        </div>
      </div>
    </section>
  )
}

function Stat({
  dot,
  active,
  value,
  label,
}: {
  dot: keyof typeof STATUS_DOT
  active: boolean
  value: number
  label: string
}) {
  // Not a description list: the value reads before the label visually, which
  // would force <dd> ahead of <dt> in source order (invalid HTML). Use a plain
  // group instead, and expose the value+label pair to assistive tech via
  // aria-label so it still reads as one unit ("5 Running").
  return (
    <div
      className={cn("flex items-center gap-2 transition-opacity", !active && "opacity-40")}
      aria-label={`${value} ${label}`}
    >
      <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[dot])} aria-hidden />
      <span className="text-lg font-semibold leading-none tabular-nums" aria-hidden>
        {value}
      </span>
      <span className="text-xs text-muted-foreground" aria-hidden>
        {label}
      </span>
    </div>
  )
}

function DeviceSummarySkeleton() {
  return (
    <div className="mb-8 h-[4.75rem] animate-pulse rounded-xl bg-card ring-1 ring-foreground/10" />
  )
}

/* ── Device controls (roadmap) ──────────────────────────────────────────── */

// Honest placeholders. These name what the control plane will grow into
// without pretending to work — each is disabled and carries a plain "Soon"
// tag, so the roadmap is visible but nothing here misleads.
const CONTROLS = [
  { icon: Archive, label: "Backups", desc: "Restore points for your apps" },
  { icon: RefreshCw, label: "Restart", desc: "Safely reboot your device" },
  { icon: Users, label: "Users", desc: "Invite people to your LibrePod" },
] as const

function ControlsPanel() {
  return (
    <section aria-labelledby="controls-heading" className="mt-12">
      <h2 id="controls-heading" className="mb-4 text-sm font-medium text-muted-foreground">
        Device controls
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CONTROLS.map(({ icon: Icon, label, desc }) => (
          <div
            key={label}
            aria-disabled
            className="flex items-start gap-3 rounded-xl bg-card/60 p-4 ring-1 ring-foreground/10"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-muted-foreground">
              <Icon className="size-[18px]" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium leading-tight text-foreground/70">{label}</p>
                <SoonTag />
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ── First run ──────────────────────────────────────────────────────────── */

// The empty control plane. Not "nothing here" — a welcome that says what this
// device is, reports it healthy, and points to the one next action: install a
// first app. Mirrors the ErrorBlock/EmptyState centred rhythm.
function FirstRun({ baseDomain }: { baseDomain?: string }) {
  return (
    <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-foreground/8 text-foreground">
        <Server className="size-6" aria-hidden />
      </span>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-semibold">Welcome to your LibrePod</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This is your control plane — the apps you install appear here, ready to open in one
          click. You have no apps installed yet.
        </p>
      </div>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("size-2 rounded-full", STATUS_DOT.running)} aria-hidden />
        Device online{baseDomain ? ` · ${baseDomain}` : ""}
      </p>

      <Link
        to="/catalog"
        className="mt-1 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground
                   transition-all duration-150 hover:bg-primary/90 active:translate-y-px
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        Browse the Catalog
        <ArrowRight className="size-4" aria-hidden />
      </Link>
    </div>
  )
}
