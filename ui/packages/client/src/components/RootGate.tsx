import { Outlet } from "react-router-dom"
import { useBootstrapStatus } from "@/hooks/useBootstrapStatus"
import { FullScreenSpinner } from "@/components/FullScreenSpinner"
import { NotSetUpScreen, UseDomainScreen, WakingScreen } from "@/components/PreAuthScreens"
import { OnboardingPage } from "@/pages/onboarding/OnboardingPage"

/**
 * Sits ABOVE AuthGate. One status decides the whole pre-auth experience:
 *   waiting, or no answer     → WakingScreen
 *   finished                  → domain: the app (Outlet) · raw IP: UseDomainScreen
 *   open + domain             → NotSetUpScreen (setup runs on the raw IP)
 *   claimed + domain          → the app: AuthGate's SSO sign-in finishes onboarding
 *   open or claimed + raw IP  → the wizard, at any path
 */
export function RootGate() {
  const { data, isPending, refetch } = useBootstrapStatus()
  if (isPending) return <FullScreenSpinner />
  if (!data || data.state === "waiting") return <WakingScreen />
  if (data.state === "finished") return data.arrival === "ip" ? <UseDomainScreen status={data} /> : <Outlet />
  if (data.arrival === "domain") return data.state === "open" ? <NotSetUpScreen /> : <Outlet />
  return <OnboardingPage status={data} onRefresh={() => void refetch()} />
}
