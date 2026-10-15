import { useEffect, useState } from "react"
import type { InstallValidationErrorBody, OnboardingStatus, WgPeer } from "@librepod/shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { postJson } from "./api"

/** "wireguard" = the wizard installs wg-easy; "own" = the owner brings their own
 *  connectivity (Tailscale/Headscale, a tunnel, their own DNS). Page state only. */
export type ConnectivityPath = "wireguard" | "own"

/** The VPN app the wizard installs (server allowlist: POST /api/bootstrap/install). */
const VPN_APP = "wg-easy"
/** Installing longer than this on this page means WireGuard isn't coming up here. */
export const STUCK_AFTER_MS = 5 * 60 * 1000

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** "Reach your LibrePod by name": WireGuard (recommended) or "I'll bring my own".
 *  The server answers wg-easy's admin-password question itself; the browser sends
 *  only the endpoint the owner confirmed. */
export function VpnStep({ status, onWireguard, onOwn, onSessionLost }: {
  status: OnboardingStatus
  onWireguard: () => void
  onOwn: () => void
  onSessionLost: () => void
}) {
  const [endpoint, setEndpoint] = useState(status.endpointSuggestion ?? "")
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const installed = status.vpnStatus != null && status.vpnStatus !== "not_installed"

  async function install() {
    setBusy(true); setError(null); setFieldError(null)
    try {
      const res = await postJson("/api/bootstrap/install", { app: VPN_APP, settings: { INIT_HOST: endpoint.trim() } })
      // 409 = already installed (e.g. a retry after a lost response): same outcome.
      if (res.ok || res.status === 409) {
        onWireguard()
        return
      }
      if (res.status === 401) {
        onSessionLost()
        return
      }
      const errors = (res.body as Partial<InstallValidationErrorBody>).errors
      const onField = errors?.find((e) => e.name === "INIT_HOST")?.message
      if (onField) setFieldError(onField)
      else setError(errors?.[0]?.message ?? res.message ?? `setting up WireGuard failed (${res.status})`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Reach your LibrePod by name</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Nothing on your network knows <span className="font-mono">{status.baseDomain}</span> yet. Choose how
        your phone and laptop will reach it.
      </p>
      {installed ? (
        <div className="mt-6">
          <p className="text-sm text-muted-foreground">✓ WireGuard is installed.</p>
          <Button className="mt-4" onClick={onWireguard}>Continue</Button>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="rounded-lg border border-border p-4">
            <p className="text-sm font-medium">WireGuard <span className="text-muted-foreground">(recommended)</span></p>
            <p className="mt-1 text-sm text-muted-foreground">
              A private tunnel to this device. Once your phone or laptop is connected, every{" "}
              <span className="font-mono">*.{status.baseDomain}</span> address works.
            </p>
            <label htmlFor="vpn-endpoint" className="mt-4 block text-sm font-medium">Endpoint host</label>
            <Input id="vpn-endpoint" className="mt-1 font-mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">
              The address your devices dial — this device's address as they see it. On a cloud server, its public IP.
            </p>
            {fieldError && <p role="alert" className="mt-1 text-xs text-destructive">{fieldError}</p>}
            {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
            <Button className="mt-4" onClick={install} disabled={busy || endpoint.trim() === ""}>
              {busy ? "Setting up…" : "Set up WireGuard"}
            </Button>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-sm font-medium">I'll bring my own</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Already using Tailscale, Headscale, a tunnel or your own DNS? Skip WireGuard and point{" "}
              <span className="font-mono">{status.baseDomain}</span> and{" "}
              <span className="font-mono">*.{status.baseDomain}</span> at this device yourself.
            </p>
            <Button className="mt-4" variant="outline" onClick={onOwn}>I'll bring my own</Button>
          </div>
        </div>
      )}
    </section>
  )
}

export function TrustStep({ onDone }: { onDone: () => void }) {
  const [installed, setInstalled] = useState(localStorage.getItem("librepod-onboarding-ca") === "1")
  return (
    <section>
      <h1 className="text-2xl font-semibold">Trust your device</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your device issues its own certificates. Installing this root certificate on your
        phone and laptop now means every address ends in a clean padlock, starting with the
        next step.
      </p>
      <Button className="mt-6" render={<a href="/api/bootstrap/ca" download />}>
        Download root certificate
      </Button>
      <details className="mt-4 text-sm text-muted-foreground">
        <summary className="cursor-pointer text-foreground">How to install</summary>
        <ul className="mt-2 space-y-1">
          <li><b>iPhone/iPad:</b> Settings → Profile Downloaded → Install, then Settings → General → About → Certificate Trust Settings → enable full trust.</li>
          <li><b>Android:</b> Settings → Security → Install a certificate → CA certificate.</li>
          <li><b>macOS:</b> Keychain Access → System → Import, then double-click → Always Trust.</li>
          <li><b>Windows:</b> Double-click → Install Certificate → Local Machine → Trusted Root Certification Authorities.</li>
          <li><b>Ubuntu:</b> <code>sudo cp librepod-root-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates</code></li>
        </ul>
      </details>
      <label className="mt-6 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={installed}
          onChange={(e) => { setInstalled(e.target.checked); localStorage.setItem("librepod-onboarding-ca", e.target.checked ? "1" : "0") }} />
        I installed the certificate
      </label>
      <Button className="mt-4" disabled={!installed} onClick={onDone}>Continue</Button>
    </section>
  )
}

/** WireGuard isn't coming up: an error, or still installing STUCK_AFTER_MS after this
 *  step appeared. Either way the owner may switch to their own connectivity. */
function useStuck(vpnStatus: OnboardingStatus["vpnStatus"]): boolean {
  const [since] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const installing = vpnStatus === "installing"
  useEffect(() => {
    if (!installing) return
    const t = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [installing])
  return vpnStatus === "error" || (installing && now - since >= STUCK_AFTER_MS)
}

/** Connect makes and shows ONE key — the owner's device — and waits for it to say
 *  hello. Every other device is added on WireGuard's own page once signed in. */
export function ConnectStep({ status, onConnected, onUseOwn, onSessionLost }: {
  status: OnboardingStatus
  onConnected: () => void
  onUseOwn: () => void
  onSessionLost: () => void
}) {
  const [name, setName] = useState("")
  const [created, setCreated] = useState<Pick<WgPeer, "clientId" | "name"> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stuck = useStuck(status.vpnStatus)
  // Flux is still rolling wg-easy out (or retrying a failed rollout): nothing to create yet.
  const settingUp = status.vpnStatus === "installing" || status.vpnStatus === "error"
  const peers = usePeers(!settingUp)
  const shown = created ?? (peers ? newest(peers) : null)
  const connected = !!status.lastHandshakeAt

  async function createPeer() {
    setBusy(true); setError(null)
    try {
      const res = await postJson("/api/bootstrap/wireguard/peer", { name: name || "my-device" })
      if (res.status === 401) {
        onSessionLost()
        return
      }
      if (!res.ok) throw new Error(res.message ?? `creating the key failed (${res.status})`)
      const body = res.body as Pick<WgPeer, "clientId" | "name">
      setCreated({ clientId: body.clientId, name: body.name })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Connect your first device</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        A private network between this device and yours. It also carries the name
        resolution that turns <span className="font-mono">*.{status.baseDomain}</span> into real addresses.
      </p>
      {stuck ? (
        <div className="mt-6 rounded-lg border border-border p-4 text-sm">
          <p className="font-medium">WireGuard couldn't start on this device</p>
          <p className="mt-2 text-muted-foreground">
            Some networks and clusters block what it needs — UDP port 51820, or a kernel setting.
            You can keep waiting, or use your own connectivity instead. WireGuard stays installed;
            you can remove it from the catalog later.
          </p>
          <Button className="mt-3" onClick={onUseOwn}>Use my own connectivity instead</Button>
        </div>
      ) : settingUp ? (
        <div className="mt-6 rounded-lg border border-border p-4">
          <p className="flex items-center gap-2 text-sm">
            <span aria-hidden className="inline-block size-2 animate-pulse rounded-full bg-muted-foreground/40" />
            Setting up WireGuard… this takes a minute or two.
          </p>
        </div>
      ) : (
        <>
          {shown ? (
            <KeyPanel peer={shown} />
          ) : !peers ? (
            // Until the list answers, a create form would invite a duplicate key.
            <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
              <span aria-hidden className="inline-block size-2 animate-pulse rounded-full bg-muted-foreground/40" />
              Looking for your connection key…
            </p>
          ) : (
            <div className="mt-6 space-y-3">
              <label htmlFor="peer-name" className="text-sm font-medium">Name this device (e.g. “phone”)</label>
              <Input id="peer-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="phone" />
              <Button onClick={createPeer} disabled={busy}>{busy ? "Creating…" : "Create connection key"}</Button>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
          )}
          <div className="mt-6 rounded-lg border border-border p-4">
            <p className="flex items-center gap-2 text-sm">
              <span aria-hidden className={"inline-block size-2 rounded-full " + (connected ? "bg-emerald-500" : "animate-pulse bg-muted-foreground/40")} />
              {connected
                ? "Connected — your device said hello."
                : "Waiting for the handshake — scan the code with WireGuard and connect."}
            </p>
            <Button className="mt-3" variant={connected ? "default" : "outline"} disabled={!connected} onClick={onConnected}>
              Continue
            </Button>
            {!connected && (
              <>
                <button className="ml-3 text-xs text-muted-foreground hover:text-foreground" onClick={onConnected}>
                  Skip — I’ll connect later
                </button>
                {/* A running WireGuard that never hears a handshake is the blocked-UDP case. */}
                <p className="mt-3 text-xs text-muted-foreground">
                  Can’t connect? Some networks block WireGuard’s UDP port 51820.{" "}
                  <button className="underline hover:text-foreground" onClick={onUseOwn}>
                    Use my own connectivity instead
                  </button>
                </p>
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}

/** wg-easy ids are ascending integers, so the highest is the newest key. */
function newest(peers: WgPeer[]): WgPeer | null {
  return peers.reduce<WgPeer | null>((a, p) => (!a || Number(p.clientId) > Number(a.clientId) ? p : a), null)
}

/** The peer list — so a reload shows the key already made instead of the create
 *  form — polled only while Connect can show it (`enabled`). */
function usePeers(enabled: boolean): WgPeer[] | undefined {
  const [peers, setPeers] = useState<WgPeer[] | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch("/api/bootstrap/wireguard")
        if (res.ok && alive) setPeers(((await res.json()) as { peers: WgPeer[] }).peers)
      } catch { /* transient — next tick retries */ }
    }
    tick()
    const t = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [enabled])
  return peers
}

function KeyPanel({ peer }: { peer: Pick<WgPeer, "clientId" | "name"> }) {
  return (
    <div className="mt-6 flex flex-col items-center gap-3 rounded-lg border border-border p-4">
      <img
        src={`/api/bootstrap/wireguard/clients/${encodeURIComponent(peer.clientId)}/qrcode.svg`}
        alt={`WireGuard configuration QR for ${peer.name}`}
        className="size-56 rounded bg-white p-2"
      />
      <a className="text-sm underline underline-offset-4"
        href={`/api/bootstrap/wireguard/clients/${encodeURIComponent(peer.clientId)}/configuration`} download>
        Download configuration file
      </a>
      <p className="text-xs text-muted-foreground">
        Install the WireGuard app, scan this code (or import the file), and switch the tunnel on.
      </p>
    </div>
  )
}

/** The hand-off to the domain. The first sign-in there finishes onboarding; the page
 *  notices (status polling) and RootGate switches to UseDomainScreen. */
export function GraduateStep({ status, path }: { status: OnboardingStatus; path: ConnectivityPath }) {
  const url = `https://${status.baseDomain}`
  const signIn = `${status.account ?? "your account"}@${status.baseDomain}`
  if (path === "own") {
    return (
      <section>
        <p className="text-sm text-muted-foreground">Almost there. Your device's name:</p>
        <h1 className="mt-2 font-mono text-3xl font-semibold break-all">{status.baseDomain}</h1>
        <ul className="mt-4 space-y-2 text-sm text-muted-foreground" aria-label="before you sign in">
          <li>
            ☐ <span className="font-mono">{status.baseDomain}</span> and <span className="font-mono">*.{status.baseDomain}</span>{" "}
            resolve to this device from your devices — through your VPN, tunnel or DNS.
          </li>
          <li>☐ The root certificate is trusted on those devices.</li>
          <li>☐ Open <span className="font-mono">{url}</span> and sign in as <span className="font-mono">{signIn}</span>.</li>
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">This page notices your first sign-in and finishes setup.</p>
        <Button className="mt-6" render={<a href={url} />}>Open {status.baseDomain}</Button>
      </section>
    )
  }
  return (
    <section className="text-center">
      <p className="text-sm text-muted-foreground">Your device now has a name.</p>
      <h1 className="mt-2 font-mono text-3xl font-semibold break-all">{status.baseDomain}</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        With the WireGuard tunnel on, open <span className="font-mono">{url}</span> and sign in as{" "}
        <span className="font-mono">{signIn}</span>. That first sign-in finishes setup — from then on,
        this raw address only points you to your device's name.
      </p>
      <Button className="mt-6" render={<a href={url} />}>Open {status.baseDomain}</Button>
      <p className="mt-4 text-xs text-muted-foreground">
        More devices? Once you're signed in, add them on WireGuard's page,{" "}
        <span className="font-mono">wg-easy.{status.baseDomain}</span>.
      </p>
    </section>
  )
}
