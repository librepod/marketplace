import React from "react"
import { Link } from "react-router-dom"
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
    // Mirror the catalog: poll while any installed app is still installing, so
    // My Apps reflects the installing → running transition without a manual refresh.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((a) => a.installedStatus === 'installing')
        ? 3000
        : false,
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
        <div className="mt-12 flex flex-col items-center gap-3 text-center">
          <h2 className="text-xl font-semibold">No apps installed yet</h2>
          <p className="text-sm text-muted-foreground">
            Browse the <Link to="/" className="underline hover:text-foreground">Catalog</Link> to install apps.
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
