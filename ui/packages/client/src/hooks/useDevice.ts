import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api"
import type { DeviceInfo } from "@librepod/shared"

/** LibrePod OS's Device. The page polls fast; the nav and home summary slowly
 * (TanStack uses the shortest interval among mounted observers). An error keeps
 * the last data; with none, OS features stay hidden. */
export function useDevice({ pollMs = 30_000 }: { pollMs?: number } = {}) {
  return useQuery<DeviceInfo>({
    queryKey: ["device"],
    queryFn: async () => {
      const res = await apiFetch("/api/device")
      if (!res.ok) throw new Error("Failed to fetch the device")
      return res.json()
    },
    retry: 0,
    refetchInterval: pollMs,
  })
}

export function useDeviceWrite() {
  const client = useQueryClient()
  return useMutation<DeviceInfo, Error, { path: string; method: "PUT" | "POST"; body: unknown }>({
    mutationFn: async ({ path, method, body }) => {
      const res = await apiFetch(`/api/device/${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.message ?? "Something went wrong")
      return json as DeviceInfo
    },
    onSuccess: (info) => client.setQueryData(["device"], info),
  })
}
