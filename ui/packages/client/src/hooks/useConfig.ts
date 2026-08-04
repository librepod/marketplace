import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api"
import type { MarketplaceConfig } from "@librepod/shared"

/**
 * Public device config the SPA needs to build user-facing links.
 * `baseDomain` mirrors the installer's BASE_DOMAIN (see GET /api/config).
 * Cached for the session — the domain does not change while the UI is open.
 */
export function useConfig() {
  return useQuery<MarketplaceConfig>({
    queryKey: ["config"],
    queryFn: async () => {
      const res = await apiFetch("/api/config")
      if (!res.ok) throw new Error("Failed to fetch config")
      return res.json()
    },
    staleTime: Infinity,
    retry: 0,
  })
}
