import { Link } from "react-router-dom"
import { Lock } from "lucide-react"
import { useSystemApps } from "@/hooks/useSystemApps"
import { AppIcon } from "@/components/AppIcon"
import { StatusBadge } from "@/components/StatusBadge"
import { ErrorBlock } from "@/components/ErrorBlock"

/**
 * The platform's read-only health roster. System apps (traefik, casdoor, the
 * frp operator, …) are managed by the cluster, not user-installable, so they
 * live here as a status list — not launch tiles. Each row links to the app's
 * detail page (which renders "Managed by platform"). Collapsible via <details>
 * so ~14 infra components don't crowd the launcher.
 */
export function PlatformPanel() {
  const { isPending, isError, data, refetch } = useSystemApps()
  const apps = data ?? []

  return (
    <section aria-labelledby="platform-heading" className="mt-12">
      <details open>
        <summary
          id="platform-heading"
          className="mb-4 cursor-pointer text-sm font-medium text-muted-foreground"
        >
          Platform{apps.length > 0 ? ` · ${apps.length} services` : ""}
        </summary>

        {isPending && <p className="text-sm text-muted-foreground">Loading platform services…</p>}
        {isError && <ErrorBlock onRetry={refetch} />}
        {!isPending && !isError && apps.length > 0 && (
          <ul className="divide-y divide-foreground/10 rounded-xl bg-card ring-1 ring-foreground/10">
            {apps.map((app) => (
              <li key={app.name}>
                <Link
                  to={`/apps/${app.name}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/5"
                >
                  <AppIcon src={app.icon} name={app.displayName} size={48} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium leading-tight">{app.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">{app.version}</p>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground">
                    <Lock className="size-3" aria-hidden /> System
                  </span>
                  {app.installedStatus && app.installedStatus !== "not_installed" && (
                    <StatusBadge status={app.installedStatus} />
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  )
}
