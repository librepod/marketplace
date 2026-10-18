import { useState } from "react"
import { TrustSheet } from "@/pages/onboarding/ConnectivitySteps"
import { useConfig } from "@/hooks/useConfig"
import { useCaTrust } from "@/hooks/useCaTrust"

/**
 * The Sber-style distrust strip for the signed-in app. The page is served over
 * a chain this browser may not trust — if the user clicked through the
 * interstitial, only OTHER origins still fail, so the probe targets
 * `id.<domain>` (same root, guaranteed cross-origin from every app host).
 * Not dismissable, nothing persisted: it re-probes every load and vanishes on
 * the first one after the CA is installed.
 */
export function TrustBanner() {
  const { data: config } = useConfig()
  const { trust, checking, checkAgain } = useCaTrust(
    config?.baseDomain ? `https://id.${config.baseDomain}/` : undefined,
  )
  const [open, setOpen] = useState(false)

  if (trust !== "untrusted") return null
  return (
    <div role="alert" className="border-b border-amber-500/40 bg-amber-500/10 px-6 py-3 text-sm">
      <p>
        ⚠ This browser doesn't trust this device's certificates — some apps won't open
        until the root certificate is installed.{" "}
        <button className="font-medium underline underline-offset-4 hover:text-foreground" onClick={() => setOpen(!open)}>
          {open ? "Hide instructions" : "Install the root certificate"}
        </button>
        {" · "}
        <button className="underline underline-offset-4 hover:text-foreground" onClick={checkAgain} disabled={checking}>
          {checking ? "Checking…" : "Check again"}
        </button>
      </p>
      {open && (
        <div className="mt-3">
          <TrustSheet />
        </div>
      )}
    </div>
  )
}
