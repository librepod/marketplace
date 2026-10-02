import { Outlet } from "react-router-dom"
import { useBootstrapStatus } from "@/hooks/useBootstrapStatus"
import { FullScreenSpinner } from "@/components/FullScreenSpinner"
import { UseDomainScreen, WakingScreen } from "@/components/PreAuthScreens"
import { OnboardingPage } from "@/pages/onboarding/OnboardingPage"

/**
 * The mode router that sits ABOVE AuthGate. One status object decides the
 * whole pre-auth experience:
 *   waiting                → WakingScreen (services converging)
 *   onboarding             → the wizard
 *   ready + domain arrival → the normal authenticated app (Outlet)
 *   ready + ip arrival     → graduated but addressed by IP: UseDomainScreen
 *                            (until a handshake has been seen, the wizard
 *                            still owns the screen so setup can finish)
 */
export function RootGate() {
  const { data, isPending } = useBootstrapStatus()
  if (isPending) return <FullScreenSpinner />
  if (!data || data.mode === "waiting") return <WakingScreen status={data} />
  if (data.mode === "onboarding") return <OnboardingPage status={data} />
  if (data.arrival === "ip") {
    return data.lastHandshakeAt ? <UseDomainScreen status={data} /> : <OnboardingPage status={data} />
  }
  return <Outlet />
}
