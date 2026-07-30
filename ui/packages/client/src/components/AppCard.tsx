import type { CatalogApp } from "@librepod/shared"
import { Link } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { AppIcon } from "@/components/AppIcon"
import { StatusBadge } from "@/components/StatusBadge"
import { cn } from "@/lib/utils"

export function AppCard({ app }: { app: CatalogApp }) {
  // The whole card is the navigation target. Rendering it as a real <Link>
  // (rather than a <div onClick>) makes it keyboard-operable: focusable in the
  // tab order, Enter activates it, and screen readers announce it as a link —
  // WCAG 2.1.1 on the primary browse surface. The card classes mirror the
  // presentational <Card> (rounded-xl bg-card ring-1 ring-foreground/10).
  return (
    <Link
      to={`/apps/${app.name}`}
      aria-label={app.displayName}
      className={cn(
        "relative block rounded-xl bg-card p-4 text-sm text-card-foreground ring-1 ring-foreground/10",
        "transition-all duration-150",
        "hover:-translate-y-0.5 hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      )}
    >
      {app.installedStatus && app.installedStatus !== 'not_installed' && (
        <div className="absolute right-4 top-4 z-10">
          <StatusBadge status={app.installedStatus} />
        </div>
      )}
      <AppIcon src={app.icon} name={app.displayName} size={48} />
      <div className="mt-3 flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words text-xl font-semibold leading-tight">
          {app.displayName}
        </h3>
        <Badge variant="secondary" className="shrink-0">{app.category}</Badge>
      </div>
      <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
        {app.description}
      </p>
    </Link>
  )
}
