import { useCallback, useEffect, useState } from "react"

/** Probe verdict. `unknown` = not settled yet (no URL, or in flight). */
export type CaTrust = "unknown" | "trusted" | "untrusted"

/** A silent probe counts against trust: the probed host is known-live from the
 *  page's own perspective, so "cannot even connect" is never good news. */
const TIMEOUT_MS = 10_000

/**
 * Whether THIS browser trusts the device's root CA — the one thing the page
 * can't observe directly (an untrusted chain means this page wouldn't have
 * loaded; a click-through "proceed anyway" hides it too). Instead: a `no-cors`
 * fetch to a DIFFERENT host signed by the same root. It resolves opaque on any
 * HTTP answer and rejects only on network-level failure, TLS rejection
 * included — and since a certificate exception blesses only the origin it was
 * granted on, the cross-origin probe keeps failing until the root itself is
 * trusted. Nothing is persisted: every mount and every `checkAgain()` re-probes,
 * so UI built on this self-heals the moment the CA is installed.
 */
export function useCaTrust(probeUrl: string | undefined): {
  trust: CaTrust
  checking: boolean
  checkAgain: () => void
} {
  const [trust, setTrust] = useState<CaTrust>("unknown")
  const [checking, setChecking] = useState(probeUrl != null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!probeUrl) return
    let alive = true
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    setChecking(true)
    fetch(probeUrl, { mode: "no-cors", signal: ac.signal }).then(
      () => { if (alive) setTrust("trusted") },
      () => { if (alive) setTrust("untrusted") }, // rejection or timeout — same verdict
    ).finally(() => {
      clearTimeout(timer)
      if (alive) setChecking(false)
    })
    return () => { alive = false; clearTimeout(timer); ac.abort() }
  }, [probeUrl, nonce])

  const checkAgain = useCallback(() => setNonce((n) => n + 1), [])
  return { trust, checking, checkAgain }
}
