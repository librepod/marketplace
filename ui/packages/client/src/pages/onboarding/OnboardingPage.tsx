import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Navigate } from "react-router-dom"
import type { OnboardingStatus, WgPeer } from "@librepod/shared"
import { useBootstrapStatus } from "@/hooks/useBootstrapStatus"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"

/**
 * The first-run wizard. One hero — the owner — and it ends. Step truth is
 * derived from the live status on every render (cluster truth, no wizard
 * state), so reloads and pod restarts resume for free; the user can always
 * walk back to a completed step, and forward only through the gates.
 */
const STEPS = ["Welcome", "Claim", "Trust", "Connect", "Graduate"] as const

function deriveStep(s: OnboardingStatus): number {
  if (!s.adminClaimed) return 1
  // unknown (wg-easy unreachable → null) lands on Trust, the step before
  // Connect — never skip the CA install just because the peer list is blank
  if (s.peerCount == null || s.peerCount === 0) return 2
  if (!s.lastHandshakeAt) return 3
  return 4
}

export function OnboardingPage({ status: propStatus }: { status?: OnboardingStatus }) {
  // Hooks first — the early returns below must never skip them.
  const query = useBootstrapStatus()
  const [userStep, setUserStep] = useState<number | null>(null)
  const status = propStatus ?? query.data
  if (!status) return null
  // Outside onboarding-with-a-reason the normal app owns the screen.
  if (status.mode === "ready" && status.arrival === "domain" && status.lastHandshakeAt) {
    return <Navigate to="/" replace />
  }
  const derived = deriveStep(status)
  const seenWelcome = localStorage.getItem("librepod-onboarding-welcome") === "1"
  const floor = derived === 1 && !seenWelcome ? 0 : derived
  const step = Math.max(floor, userStep ?? 0, 0)
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-lg">
        <StepRail current={step} />
        <Separator className="my-6" />
        {step === 0 && <WelcomeStep onBegin={() => { localStorage.setItem("librepod-onboarding-welcome", "1"); setUserStep(1) }} />}
        {step === 1 && <ClaimStep done={!!status.adminClaimed} baseDomain={status.baseDomain} onDone={() => { query.refetch(); setUserStep(2) }} />}
        {step === 2 && <TrustStep onDone={() => setUserStep(3)} />}
        {step === 3 && <ConnectStep status={status} onConnected={() => setUserStep(4)} />}
        {step === 4 && <GraduateStep status={status} />}
        {step > 0 && step < 4 && (
          <button className="mt-6 text-xs text-muted-foreground hover:text-foreground" onClick={() => setUserStep(step - 1)}>
            Back
          </button>
        )}
      </div>
    </div>
  )
}

function StepRail({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="setup progress">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span
            aria-current={i === current ? "step" : undefined}
            className={
              "flex size-6 items-center justify-center rounded-full text-xs font-medium " +
              (i < current
                ? "bg-primary text-primary-foreground"
                : i === current
                  ? "border border-primary text-foreground"
                  : "border border-border text-muted-foreground/60")
            }
          >
            {i < current ? "✓" : i + 1}
          </span>
          <span className={"text-xs " + (i === current ? "text-foreground" : "text-muted-foreground/60")}>{label}</span>
        </li>
      ))}
    </ol>
  )
}

function WelcomeStep({ onBegin }: { onBegin: () => void }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Welcome to your LibrePod</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        You are on the raw device address — that is how every LibrePod starts. In about
        five minutes this setup gives your device a name, a single sign-in, and your own
        private network. No terminals involved.
      </p>
      <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
        <li>1 · Claim it — your admin sign-in</li>
        <li>2 · Trust it — install its root certificate</li>
        <li>3 · Connect — bring your phone or laptop onto the private network</li>
      </ul>
      <Button className="mt-6" onClick={onBegin}>Begin</Button>
    </section>
  )
}

function ClaimStep({ done, baseDomain, onDone }: { done: boolean; baseDomain: string; onDone: () => void }) {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError("Passwords do not match")
      return
    }
    setBusy(true); setError(null)
    try {
      const res = await fetch("/api/bootstrap/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message ?? `claim failed (${res.status})`)
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Claim your device</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This device has a single administrator. The password you set here is the one
        and only sign-in for everything — the app store, single sign-on, and the VPN.
        Anyone on this network could claim it first; that window closes the moment you
        finish this step.
      </p>
      <p className="mt-4 font-mono text-sm">admin@{baseDomain}</p>
      <form className="mt-4 space-y-4" onSubmit={submit}>
        <div>
          <label htmlFor="claim-password" className="text-sm font-medium">Password</label>
          <Input id="claim-password" type="password" className="mt-1" autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          <p className="mt-1 text-xs text-muted-foreground">At least 8 characters, no spaces.</p>
        </div>
        <div>
          <label htmlFor="claim-confirm" className="text-sm font-medium">Confirm password</label>
          <Input id="claim-confirm" type="password" className="mt-1" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || password.length < 8 || password !== confirm}>
          {busy ? "Claiming…" : "Claim this device"}
        </Button>
      </form>
      {done && (
        <p className="mt-4 text-sm text-muted-foreground">
          ✓ This device is already claimed — you are revisiting this step.
        </p>
      )}
    </section>
  )
}

function TrustStep({ onDone }: { onDone: () => void }) {
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

function ConnectStep({ status, onConnected }: { status: OnboardingStatus; onConnected: () => void }) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { peers, refresh } = usePeers(status)
  const list = peers ?? []
  const connected = !!status.lastHandshakeAt

  async function createPeer() {
    setBusy(true); setError(null)
    try {
      const res = await fetch("/api/bootstrap/wireguard/peer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name || "my-device" }),
      })
      if (!res.ok) throw new Error(`creating the key failed (${res.status})`)
      await refresh() // swap the create form for the QR immediately —
                      // waiting for the 5s tick invites duplicate peers
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
      {list.length === 0 ? (
        <div className="mt-6 space-y-3">
          <label htmlFor="peer-name" className="text-sm font-medium">Name this device (e.g. “phone”)</label>
          <Input id="peer-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="phone" />
          <Button onClick={createPeer} disabled={busy}>{busy ? "Creating…" : "Create connection key"}</Button>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
      ) : (
        <PeerPanel peers={list} />
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
          <button className="ml-3 text-xs text-muted-foreground hover:text-foreground"
            onClick={onConnected}>Skip — I’ll connect later</button>
        )}
      </div>
    </section>
  )
}

/** Polls the peer list only while this step needs to show it. `refresh`
 * lets a successful create swap the form for the QR without waiting for
 * the 5s tick (which invites duplicate peers). */
function usePeers(status: OnboardingStatus): { peers: WgPeer[] | undefined; refresh: () => Promise<void> } {
  const [peers, setPeers] = useState<WgPeer[] | undefined>(undefined)
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/bootstrap/wireguard")
      if (res.ok) setPeers(((await res.json()) as { peers: WgPeer[] }).peers)
    } catch { /* transient — the interval retries */ }
  }, [])
  useEffect(() => {
    if (!status.adminClaimed) return
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
  }, [status.adminClaimed])
  return { peers, refresh }
}

function PeerPanel({ peers }: { peers: WgPeer[] }) {
  const [selected, setSelected] = useState(peers[0]?.clientId ?? "")
  const peer = peers.find((p) => p.clientId === selected) ?? peers[0]
  if (!peer) return null
  return (
    <div className="mt-6">
      {peers.length > 1 && (
        <select aria-label="connection key" className="mb-3 w-full rounded-md border border-input bg-transparent p-2 text-sm"
          value={peer.clientId} onChange={(e) => setSelected(e.target.value)}>
          {peers.map((p) => <option key={p.clientId} value={p.clientId}>{p.name || p.clientId}</option>)}
        </select>
      )}
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border p-4">
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
    </div>
  )
}

function GraduateStep({ status }: { status: OnboardingStatus }) {
  return (
    <section className="text-center">
      <p className="text-sm text-muted-foreground">Your device now has a name.</p>
      <h1 className="mt-2 font-mono text-3xl font-semibold break-all">{status.baseDomain}</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Leave the raw address behind. The next screen asks you to sign in as{" "}
        <span className="font-mono">admin@{status.baseDomain}</span> with the password you
        set — that sign-in follows you into every app you install.
      </p>
      <Button className="mt-6" render={<a href={`https://${status.baseDomain}`} />}>
        Enter {status.baseDomain}
      </Button>
    </section>
  )
}
