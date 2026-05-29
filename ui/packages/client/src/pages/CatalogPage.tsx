import React from "react"
import { useQuery } from "@tanstack/react-query"
import type { CatalogApp } from "@librepod/shared"
import { AppCard } from "@/components/AppCard"
import { AppCardSkeleton } from "@/components/AppCardSkeleton"
import { ErrorBlock } from "@/components/ErrorBlock"
import { EmptyState } from "@/components/EmptyState"

const GRID_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
  gap: 24,
}

export function CatalogPage() {
  const { isPending, isError, data, refetch } = useQuery<CatalogApp[]>({
    queryKey: ["apps"],
    queryFn: async () => {
      const res = await fetch("/api/apps")
      if (!res.ok) throw new Error("Failed to fetch apps")
      const json = await res.json()
      return json.apps ?? json
    },
    retry: 0,
  })

  return (
    <>
      <h1 className="sr-only">App Catalog</h1>
      {isPending && (
        <div style={GRID_STYLE}>
          {Array.from({ length: 12 }).map((_, i) => (
            <AppCardSkeleton key={i} />
          ))}
        </div>
      )}
      {!isPending && isError && <ErrorBlock onRetry={refetch} />}
      {!isPending && !isError && (!data || data.length === 0) && <EmptyState />}
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
