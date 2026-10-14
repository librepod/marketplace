import { useQuery } from "@tanstack/react-query"
import type { OnboardingStatus } from "@librepod/shared"

/**
 * The pre-auth heartbeat. Plain fetch on purpose — apiFetch's 401 handler
 * redirects to /api/auth/login, which on a fresh device is a redirect into an
 * unresolvable host. That redirect is the exact bug onboarding fixes.
 */
export function useBootstrapStatus() {
  return useQuery<OnboardingStatus>({
    queryKey: ["bootstrapStatus"],
    queryFn: async () => {
      const res = await fetch("/api/bootstrap/status")
      if (!res.ok) throw new Error(`bootstrap status ${res.status}`)
      return res.json()
    },
    // The wizard follows live state (claim, install, peers, the first sign-in) until
    // onboarding finishes. Finished is final — the domain app, or the static
    // UseDomainScreen — so polling stops there.
    refetchInterval: (query) => (query.state.data?.state === "finished" ? false : 4000),
  })
}
