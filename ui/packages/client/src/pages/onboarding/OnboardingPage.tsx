import { useState, type ReactNode } from "react"
import type { OnboardingStatus } from "@librepod/shared"
import { Separator } from "@/components/ui/separator"
import { AccountStep, ClaimStep, ResumeScreen, WelcomeStep } from "./AccessSteps"
import { ConnectStep, GraduateStep, VpnStep, type ConnectivityPath } from "./ConnectivitySteps"

/**
 * The first-run wizard: raw-IP arrivals while the device is open or claimed. One
 * hero — the owner — and it ends with their first sign-in at the domain. The step
 * comes from the live status on every render (cluster truth), so reloads and pod
 * restarts resume for free. Page memory holds only the connectivity path ("bring
 * my own" — a reload asks again) and a step the owner moved ahead to. There is no
 * Back: a step the device has done can't be undone from here, and a reload returns
 * to the first one it hasn't. Certificate trust is not a step: the app's banner
 * teaches it after the first sign-in, and Graduate sets the warning expectation.
 */
const STEPS = ["Welcome", "Claim", "Account", "Reach", "Connect", "Graduate"] as const
export const WELCOME = 0
export const CLAIM = 1
export const ACCOUNT = 2
export const VPN = 3
export const CONNECT = 4
export const GRADUATE = 5

const WELCOME_KEY = "librepod-onboarding-welcome"

export function deriveStep(s: OnboardingStatus): number {
  if (s.state !== "claimed") return CLAIM
  if (!s.account) return ACCOUNT
  // An unknown VPN status counts as not installed: a repeat install is harmless
  // (409 counts as success). Past that, Connect until a handshake ends setup.
  if (s.vpnStatus === "not_installed" || s.vpnStatus == null) return VPN
  if (s.lastHandshakeAt) return GRADUATE
  return CONNECT
}

/** `reconnecting`: the device answered `waiting` mid-setup; `status` is the last good one. */
export function OnboardingPage({ status, onRefresh, reconnecting = false }: {
  status: OnboardingStatus
  onRefresh: () => void
  reconnecting?: boolean
}) {
  // Hooks first — the early return below must never skip them.
  const [userStep, setUserStep] = useState<number | null>(null)
  const [path, setPath] = useState<ConnectivityPath>("wireguard")

  if (status.state === "claimed" && !status.session) {
    return <Frame reconnecting={reconnecting}><ResumeScreen onResumed={onRefresh} /></Frame>
  }

  const derived = deriveStep(status)
  const seenWelcome = localStorage.getItem(WELCOME_KEY) === "1"
  const floor = derived === CLAIM && !seenWelcome ? WELCOME : derived
  const step = Math.max(floor, userStep ?? 0)
  const go = setUserStep
  // Steps the device has done, not steps jumped over on the way to a later one
  // (bring-my-own skips Connect — it must not show a checkmark).
  const done = Math.min(derived, step)

  return (
    <Frame reconnecting={reconnecting}>
      <StepRail current={step} done={done} />
      <Separator className="my-6" />
      {step === WELCOME && <WelcomeStep onBegin={() => { localStorage.setItem(WELCOME_KEY, "1"); go(CLAIM) }} />}
      {step === CLAIM && <ClaimStep onClaimed={onRefresh} />}
      {step === ACCOUNT && (
        <AccountStep baseDomain={status.baseDomain} previousAccount={status.previousAccount}
          onDone={() => { onRefresh(); go(VPN) }} onSessionLost={onRefresh} />
      )}
      {step === VPN && (
        <VpnStep status={status}
          onWireguard={() => { setPath("wireguard"); onRefresh(); go(CONNECT) }}
          onOwn={() => { setPath("own"); go(GRADUATE) }}
          onSessionLost={onRefresh} />
      )}
      {step === CONNECT && (
        <ConnectStep status={status} onConnected={() => go(GRADUATE)}
          onUseOwn={() => { setPath("own"); go(GRADUATE) }} onSessionLost={onRefresh} />
      )}
      {step === GRADUATE && <GraduateStep status={status} path={path} />}
    </Frame>
  )
}

function Frame({ children, reconnecting }: { children: ReactNode; reconnecting: boolean }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-lg">
        {reconnecting && (
          <p role="status" className="mb-6 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
            Your LibrePod is busy for a moment — reconnecting. What you've entered here is kept.
          </p>
        )}
        {children}
      </div>
    </div>
  )
}

function StepRail({ current, done }: { current: number; done: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="setup progress">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span
            aria-current={i === current ? "step" : undefined}
            className={
              "flex size-6 items-center justify-center rounded-full text-xs font-medium " +
              (i < done
                ? "bg-primary text-primary-foreground"
                : i === current
                  ? "border border-primary text-foreground"
                  : "border border-border text-muted-foreground/60")
            }
          >
            {i < done ? "✓" : i + 1}
          </span>
          <span className={"text-xs " + (i === current ? "text-foreground" : "text-muted-foreground/60")}>{label}</span>
        </li>
      ))}
    </ol>
  )
}
