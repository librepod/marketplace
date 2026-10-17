import { useState } from "react"
import { Outlet } from "react-router-dom"
import type { OnboardingStatus } from "@librepod/shared"
import { useBootstrapStatus } from "@/hooks/useBootstrapStatus"
import { FullScreenSpinner } from "@/components/FullScreenSpinner"
import { NotSetUpScreen, UseDomainScreen, WakingScreen } from "@/components/PreAuthScreens"
import { OnboardingPage } from "@/pages/onboarding/OnboardingPage"

const showsWizard = (s: OnboardingStatus) => s.arrival === "ip" && (s.state === "open" || s.state === "claimed")

/**
 * Sits ABOVE AuthGate. One status decides the whole pre-auth experience:
 *   waiting, or no answer     → WakingScreen (the wizard stays, if it was showing)
 *   finished                  → domain: the app (Outlet) · raw IP: UseDomainScreen
 *   open + domain             → NotSetUpScreen (setup runs on the raw IP)
 *   claimed + domain          → the app: AuthGate's SSO sign-in finishes onboarding
 *   open or claimed + raw IP  → the wizard, at any path
 */
export function RootGate() {
  const { data, isPending, refetch } = useBootstrapStatus()
  // The last status that showed the wizard. A `waiting` blip mid-setup keeps the wizard
  // mounted on it, so nothing the owner typed or chose is lost; the server, failing
  // closed, refuses the wizard's actions until the device answers again.
  const [wizard, setWizard] = useState<OnboardingStatus | null>(null)
  if (data && data.state !== "waiting") {
    const next = showsWizard(data) ? data : null
    if (next !== wizard) setWizard(next)
  }

  if (isPending) return <FullScreenSpinner />
  if (!data || data.state === "waiting") {
    return wizard ? <OnboardingPage status={wizard} onRefresh={() => void refetch()} reconnecting /> : <WakingScreen />
  }
  if (data.state === "finished") return data.arrival === "ip" ? <UseDomainScreen status={data} /> : <Outlet />
  if (data.arrival === "domain") return data.state === "open" ? <NotSetUpScreen /> : <Outlet />
  return <OnboardingPage status={data} onRefresh={() => void refetch()} />
}
