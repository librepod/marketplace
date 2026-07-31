import React from "react"
import { useQuery } from "@tanstack/react-query"
import type { CatalogApp } from "@librepod/shared"
import { AppCard } from "@/components/AppCard"
import { AppCardSkeleton } from "@/components/AppCardSkeleton"
import { CatalogToolbar } from "@/components/CatalogToolbar"
import { ErrorBlock } from "@/components/ErrorBlock"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { useCatalogFilters } from "@/hooks/useCatalogFilters"

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
    // Flux reconciles asynchronously — keep the grid live while any app is
    // mid-install so cards flip installing → running on their own. Filtering is
    // a pure view over this cached array, so polling stays transparent.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((a) => a.installedStatus === 'installing')
        ? 3000
        : false,
  })

  const {
    category,
    query,
    categories,
    filteredApps,
    setCategory,
    setQuery,
    reset,
  } = useCatalogFilters(data)

  const hasData = !isPending && !isError && data != null && data.length > 0

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
      {!isPending && !isError && (!data || data.length === 0) && (
        <EmptyState onRetry={refetch} />
      )}
      {hasData && (
        <>
          <CatalogToolbar
            query={query}
            category={category}
            categories={categories}
            onQueryChange={setQuery}
            onCategoryChange={setCategory}
          />
          {filteredApps.length > 0 ? (
            <div style={GRID_STYLE}>
              {filteredApps.map((app) => (
                <AppCard key={app.name} app={app} />
              ))}
            </div>
          ) : (
            <NoMatchesState query={query} onReset={reset} />
          )}
        </>
      )}
    </>
  )
}

// Filtered to nothing. Mirrors EmptyState/ErrorBlock rhythm so the three
// "nothing to show" surfaces read as one family; only the noun and the
// recovery (Clear filters) differ.
function NoMatchesState({
  query,
  onReset,
}: {
  query: string
  onReset: () => void
}) {
  const trimmed = query.trim()
  return (
    <div className="mt-12 flex flex-col items-center gap-3 text-center">
      <h2 className="text-xl font-semibold">No apps found</h2>
      <p className="text-sm text-muted-foreground">
        {trimmed
          ? `No apps match "${trimmed}".`
          : "No apps match the selected category."}
      </p>
      <Button variant="outline" size="sm" onClick={onReset}>
        Clear filters
      </Button>
    </div>
  )
}
