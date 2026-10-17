import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import type { OnboardingStatus } from "@librepod/shared"
import { Button } from "@/components/ui/button"

/** Fresh boot: system apps are still converging. Turns dead minutes into a
 *  progress story instead of a spinner with no explanation. */
export function WakingScreen({ status }: { status?: OnboardingStatus }) {
  const casdoorUp = status?.casdoorUp
  return (
    <Centered>
      <h1 className="text-2xl font-semibold">Your LibrePod is waking up</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        System services are starting for the first time. This usually takes a few minutes —
        this page updates itself.
      </p>
      <ul className="mt-6 space-y-2 text-sm" aria-label="service status">
        <ServiceLight label="Identity (single sign-on)" up={casdoorUp} />
        <ServiceLight label="App catalog" up={true} />
      </ul>
      <p className="mt-6 text-xs text-muted-foreground">
        You are on the raw device address ({status ? "http://" + location.host : "…"}). That is normal for a
        brand-new device — by the end of setup it will have a name.
      </p>
    </Centered>
  )
}

/** Post-graduation arrival over the raw IP: the app lives on the domain now. */
export function UseDomainScreen({ status }: { status: OnboardingStatus }) {
  return (
    <Centered>
      <p className="text-sm text-muted-foreground">Your device is set up and has a name:</p>
      <h1 className="mt-2 font-mono text-2xl font-semibold break-all">{status.baseDomain}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Connect your WireGuard tunnel (it also makes this name resolve), then open
        the address above. This raw address keeps working, but without your tunnel
        it cannot sign you in.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button render={<a href={`https://${status.baseDomain}`} />}>Open {status.baseDomain}</Button>
        <Button variant="outline" render={<Link to="/onboarding" />}>Show my connection keys</Button>
        <Button variant="ghost" render={<a href="/api/bootstrap/ca" download />}>Download root CA</Button>
      </div>
    </Centered>
  )
}

function ServiceLight({ label, up }: { label: string; up: boolean | undefined }) {
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={
          "inline-block size-2 rounded-full " +
          (up === undefined ? "animate-pulse bg-muted-foreground/40" : up ? "bg-emerald-500" : "bg-muted-foreground/40")
        }
      />
      <span className="text-muted-foreground">{label}</span>
      {up === false && <span className="text-xs text-muted-foreground/60">starting…</span>}
    </li>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-md text-center">{children}</div>
    </div>
  )
}
