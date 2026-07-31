import { useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import type { CatalogApp } from "@librepod/shared"

const CATEGORY_PARAM = "category"
const QUERY_PARAM = "q"

/**
 * Catalog browse filters, persisted in the URL so a scoped view is shareable
 * and survives refresh. Both params are optional — absent means "no filter"
 * and yields a clean URL.
 *
 * Filtering is client-side over the cached catalog data (the TanStack Query
 * `["apps"]` array). Because we never refetch to filter, the install-polling
 * (`refetchInterval`) on CatalogPage stays fully transparent: the filter is a
 * pure view over data that is already refreshing itself.
 *
 * History semantics: typing in the search box *replaces* (so each keystroke
 * doesn't flood history), while selecting a category or clearing *pushes* —
 * so the browser back button steps through category selections, not letters.
 */
export function useCatalogFilters(apps: CatalogApp[] | undefined) {
  const [params, setParams] = useSearchParams()

  const category = params.get(CATEGORY_PARAM) ?? "" // "" = All
  const query = params.get(QUERY_PARAM) ?? ""

  const categories = useMemo(
    () => Array.from(new Set((apps ?? []).map((a) => a.category))).sort(),
    [apps],
  )

  const filteredApps = useMemo(() => {
    if (!apps) return []
    const q = query.trim().toLowerCase()
    return apps.filter((a) => {
      if (category && a.category !== category) return false
      if (q && !`${a.displayName} ${a.description}`.toLowerCase().includes(q)) {
        return false
      }
      return true
    })
  }, [apps, category, query])

  const setCategory = (next: string) => {
    // Push: back should undo a category selection.
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next) p.set(CATEGORY_PARAM, next)
      else p.delete(CATEGORY_PARAM)
      return p
    })
  }

  const setQuery = (next: string) => {
    // Replace: typing shouldn't create a history entry per keystroke.
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        const v = next.trim()
        if (v) p.set(QUERY_PARAM, v)
        else p.delete(QUERY_PARAM)
        return p
      },
      { replace: true },
    )
  }

  const reset = () => setParams({}) // clear every param

  return {
    category,
    query,
    categories,
    filteredApps,
    setCategory,
    setQuery,
    reset,
  }
}
