import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api"
import type { CatalogApp } from "@librepod/shared"

export function useSystemApps() {
  return useQuery<CatalogApp[]>({
    queryKey: ["system-apps"],
    queryFn: async () => {
      const res = await apiFetch("/api/system-apps")
      if (!res.ok) throw new Error("Failed to fetch system apps")
      return res.json()
    },
    retry: 0,
    // If a platform component is still reconciling, poll until it settles.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((a) => a.installedStatus === "installing")
        ? 5000
        : false,
  })
}
