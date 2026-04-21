import type { CatalogApp } from "@librepod/shared"
import { useNavigate } from "react-router-dom"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { AppIcon } from "@/components/AppIcon"
import { cn } from "@/lib/utils"

export function AppCard({ app }: { app: CatalogApp }) {
  const navigate = useNavigate()
  return (
    <Card
      className={cn(
        "cursor-pointer transition-all duration-150",
        "hover:-translate-y-0.5 hover:shadow-md"
      )}
      onClick={() => navigate(`/apps/${app.name}`)}
    >
      <CardContent className="p-4">
        <AppIcon src={app.icon} name={app.displayName} size={48} />
        <div className="mt-3 flex items-start justify-between gap-2">
          <h3 className="text-xl font-semibold leading-tight">{app.displayName}</h3>
          <Badge variant="secondary" className="shrink-0">{app.category}</Badge>
        </div>
        <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
          {app.description}
        </p>
      </CardContent>
    </Card>
  )
}
