import { useQuery } from "@tanstack/react-query"
import type { OnboardingStatus } from "@librepod/shared"

/**
 * The pre-auth heartbeat. Plain fetch on purpose — apiFetch's 401 handler
 * redirects to /api/auth/login, which on a fresh cluster is a redirect into
 * an unresolvable host. That redirect is the exact bug onboarding fixes.
 */
export function useBootstrapStatus() {
  return useQuery<OnboardingStatus>({
    queryKey: ["bootstrapStatus"],
    queryFn: async () => {
      const res = await fetch("/api/bootstrap/status")
      if (!res.ok) throw new Error(`bootstrap status ${res.status}`)
      return res.json()
    },
    // Keep polling through the tour: mode "ready" + IP arrival still drives
    // the wizard (peer + handshake telemetry lives in this status). Stop
    // once there is nothing left to watch — the graduated domain app, or a
    // seen handshake on the raw IP (UseDomainScreen is static; polling it
    // forever would hammer wg-easy via the server for no UI change).
    refetchInterval: (query) => {
      const d = query.state.data
      if (d?.mode === "ready" && (d.arrival === "domain" || d.lastHandshakeAt)) return false
      return 4000
    },
  })
}
