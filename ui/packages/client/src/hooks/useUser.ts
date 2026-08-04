import { useQuery } from "@tanstack/react-query"
import type { User } from "@librepod/shared"
import { apiFetch } from "@/lib/api"

/** Current signed-in user, or null/401 (apiFetch redirects to login on 401). */
export function useUser() {
  return useQuery<User>({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await apiFetch("/api/me")
      if (!res.ok) throw new Error("Failed to fetch user")
      return res.json()
    },
    retry: 0,
    staleTime: 10 * 60 * 1000,
  })
}
