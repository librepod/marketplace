import type { CatalogApp } from "@librepod/shared"
import { Link } from "react-router-dom"
import { ArrowUpRight, SlidersHorizontal } from "lucide-react"
import { AppIcon } from "@/components/AppIcon"
import { StatusBadge } from "@/components/StatusBadge"
import { appUrl } from "@/lib/utils"

/**
 * The control-plane launcher unit. On the daily path this is a live link: the
 * whole body opens the running app at its own URL in a new tab. A small corner
 * control routes to the app's detail page for status and uninstall — the two
 * interactive targets are siblings, never nested (an <a>/<button> inside an <a>
 * is invalid and unfocusable), so the container is a plain positioned div.
 *
 * An app that is still installing or has errored has no address to open yet, so
 * its body routes to the detail page instead of a dead host; only a `running`
 * app launches. The tile inherits the catalog card's box exactly (rounded-xl,
 * card surface, hairline ring, hover lift) so the two grids read as one family.
 */
export function LaunchTile({ app, baseDomain }: { app: CatalogApp; baseDomain?: string }) {
  const status = app.installedStatus
  const url = appUrl(app.name, baseDomain)
  const canLaunch = status === "running" && !!url
  const host = url?.replace(/^https:\/\//, "")

  const shell =
    "group/tile relative block rounded-xl bg-card p-4 pr-12 text-card-foreground ring-1 ring-foreground/10 " +
    "transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"

  const body = (
    <>
      <AppIcon src={app.icon} name={app.displayName} size={48} />
      <h3 className="mt-3 truncate text-lg font-semibold leading-tight">
        {app.displayName}
      </h3>
      <p className="mt-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        <span className="min-w-0 truncate">{canLaunch ? host : subline(status)}</span>
        {canLaunch && (
          <ArrowUpRight
            className="size-3.5 shrink-0 opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100"
            aria-hidden
          />
        )}
      </p>
    </>
  )

  return (
    <div className="relative">
      {canLaunch ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${app.displayName}`}
          className={shell}
        >
          {body}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <Link
          to={`/apps/${app.name}`}
          aria-label={`${app.displayName} — ${subline(status)}`}
          className={shell}
        >
          {body}
        </Link>
      )}

      {status && status !== "not_installed" && (
        <div className="pointer-events-none absolute right-3 top-3 z-10">
          <StatusBadge status={status} />
        </div>
      )}

      {/* Compact 28px icon visually; the ::before expands the pointer hit area
          to the WCAG 44px minimum so the corner control is reachable on touch
          without enlarging the visible affordance. */}
      <Link
        to={`/apps/${app.name}`}
        aria-label={`Manage ${app.displayName}`}
        title={`Manage ${app.displayName}`}
        className="absolute bottom-3 right-3 z-10 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground
                   before:absolute before:inset-[-0.5rem] before:content-['']
                   transition-colors duration-150 hover:bg-muted hover:text-foreground
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        <SlidersHorizontal className="size-4" />
      </Link>
    </div>
  )
}

// The meta line under the title when the app is not launchable yet. Running
// apps show their host; these show why there's nothing to open.
function subline(status: CatalogApp["installedStatus"]): string {
  if (status === "installing") return "Setting up…"
  if (status === "error") return "Needs attention"
  return "Open details"
}
