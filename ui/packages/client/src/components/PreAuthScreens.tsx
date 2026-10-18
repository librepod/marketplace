import type { ReactNode } from "react"
import type { OnboardingStatus } from "@librepod/shared"
import { Button } from "@/components/ui/button"
import { TrustSheet } from "@/pages/onboarding/ConnectivitySteps"
import { useCaTrust } from "@/hooks/useCaTrust"

/** OpenBao or Casdoor isn't answering yet (fresh boot, or a restart). */
export function WakingScreen() {
  return (
    <Centered>
      <h1 className="text-2xl font-semibold">Your LibrePod is waking up</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        System services are starting. This usually takes a few minutes — this page updates itself.
      </p>
    </Centered>
  )
}

/** A domain arrival before anyone claimed the device: setup runs on the raw IP. */
export function NotSetUpScreen() {
  return (
    <Centered>
      <h1 className="text-2xl font-semibold">This LibrePod isn't set up yet</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Setup runs on the device's own address. Open <span className="font-mono">http://</span> followed by
        this device's IP address to start — you will need its setup code.
      </p>
    </Centered>
  )
}

/** Onboarding finished but the browser came over the raw IP: the app lives on the domain now.
 *  When the cross-origin probe says this browser doesn't trust the device (which, from a
 *  VPN-less device, also covers "not connected yet"), the screen becomes the two-step
 *  new-device helper instead of a link that would only land on an interstitial. */
export function UseDomainScreen({ status }: { status: OnboardingStatus }) {
  const { trust, checking, checkAgain } = useCaTrust(`https://${status.baseDomain}/api/health`)

  if (trust === "untrusted") {
    return (
      <Centered>
        <p className="text-sm text-muted-foreground">Your device is set up and has a name:</p>
        <h1 className="mt-2 font-mono text-2xl font-semibold break-all">{status.baseDomain}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This device can't reach it securely yet — two steps, in this order:
        </p>
        <ol className="mt-4 space-y-3 text-left">
          <li className="rounded-lg border border-border p-4">
            <p className="text-sm font-medium">1 · Trust the device</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Your device issues its own certificates. Install the root and every{" "}
              <span className="font-mono">*.{status.baseDomain}</span> address ends in a clean padlock.
            </p>
            <div className="mt-3">
              <TrustSheet />
            </div>
          </li>
          <li className="rounded-lg border border-border p-4">
            <p className="text-sm font-medium">2 · Connect this device</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Get a connection key at <span className="font-mono">wg-easy.{status.baseDomain}</span> — it opens
              once the certificate above is installed — and switch the tunnel on.
            </p>
          </li>
        </ol>
        <Button className="mt-6" variant="outline" onClick={checkAgain} disabled={checking}>
          {checking ? "Checking…" : "Check again"}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          When both steps are done, open <span className="font-mono">https://{status.baseDomain}</span> and
          sign in — that's the Marketplace.
        </p>
      </Centered>
    )
  }

  return (
    <Centered>
      <p className="text-sm text-muted-foreground">Your device is set up and has a name:</p>
      <h1 className="mt-2 font-mono text-2xl font-semibold break-all">{status.baseDomain}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Open it from a device on your VPN (or with your own DNS for it). This raw address no longer runs setup.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button render={<a href={`https://${status.baseDomain}`} />}>Open {status.baseDomain}</Button>
        <Button variant="ghost" render={<a href="/api/bootstrap/ca" download />}>Download root CA</Button>
      </div>
    </Centered>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-md text-center">{children}</div>
    </div>
  )
}
