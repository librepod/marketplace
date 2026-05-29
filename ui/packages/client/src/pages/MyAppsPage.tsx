import React from "react"
import { useQuery } from "@tanstack/react-query"
import type { CatalogApp } from "@librepod/shared"
import { AppCard } from "@/components/AppCard"
import { AppCardSkeleton } from "@/components/AppCardSkeleton"
import { ErrorBlock } from "@/components/ErrorBlock"

const GRID_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
  gap: 24,
}

export function MyAppsPage() {
  const { isPending, isError, data, refetch } = useQuery<CatalogApp[]>({
    queryKey: ["installed"],
    queryFn: async () => {
      const res = await fetch("/api/installed")
      if (!res.ok) throw new Error("Failed to fetch installed apps")
      return res.json()
    },
    retry: 0,
  })

  return (
    <>
      <h1 className="sr-only">My Apps</h1>
      {isPending && (
        <div style={GRID_STYLE}>
          {Array.from({ length: 6 }).map((_, i) => (
            <AppCardSkeleton key={i} />
          ))}
        </div>
      )}
      {!isPending && isError && <ErrorBlock onRetry={refetch} />}
      {!isPending && !isError && (!data || data.length === 0) && (
        <div className="py-16 text-center">
          <p className="text-muted-foreground">No apps installed yet.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Browse the <a href="/" className="underline hover:text-foreground">Catalog</a> to install apps.
          </p>
        </div>
      )}
      {!isPending && !isError && data && data.length > 0 && (
        <div style={GRID_STYLE}>
          {data.map((app) => (
            <AppCard key={app.name} app={app} />
          ))}
        </div>
      )}
    </>
  )
}
