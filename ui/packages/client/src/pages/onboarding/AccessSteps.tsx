import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MIN_PASSWORD, SETUP_CODE_COMMAND, postJson, validPassword } from "./api"

/** Mirrors the server's username rule. */
const USERNAME = /^[a-z0-9.-]{1,39}$/

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function WelcomeStep({ onBegin }: { onBegin: () => void }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Welcome to your LibrePod</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        You are on the device's raw address — that is how every LibrePod starts. In a few
        minutes this setup gives it an owner, your own sign-in, and a way for your phone
        and laptop to reach it by name.
      </p>
      <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
        <li>1 · Claim it — the setup code and an admin password</li>
        <li>2 · Your account — the sign-in you use every day</li>
        <li>3 · Reach it — WireGuard, or your own connectivity</li>
        <li>4 · Trust it — install its root certificate</li>
      </ul>
      <Button className="mt-6" onClick={onBegin}>Begin</Button>
    </section>
  )
}

function SetupCodeField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">Setup code</label>
      <Input id={id} className="mt-1 font-mono uppercase" placeholder="XXXX-XXXX-XXXX" autoComplete="off"
        autoCapitalize="characters" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer text-foreground">Where do I find it?</summary>
        <p className="mt-2">It is printed in this device's log. On a computer with access to the device, run:</p>
        <code className="mt-1 block break-all rounded bg-muted p-2">{SETUP_CODE_COMMAND}</code>
      </details>
    </div>
  )
}

function PasswordFields({ idPrefix, label, password, confirm, setPassword, setConfirm }: {
  idPrefix: string
  label: string
  password: string
  confirm: string
  setPassword: (v: string) => void
  setConfirm: (v: string) => void
}) {
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-password`} className="text-sm font-medium">{label}</label>
        <Input id={`${idPrefix}-password`} type="password" className="mt-1" autoComplete="new-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="mt-1 text-xs text-muted-foreground">At least {MIN_PASSWORD} characters, no spaces.</p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-confirm`} className="text-sm font-medium">Confirm {label.toLowerCase()}</label>
        <Input id={`${idPrefix}-confirm`} type="password" className="mt-1" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {confirm !== "" && password !== confirm && (
          <p className="mt-1 text-xs text-destructive">Passwords do not match</p>
        )}
      </div>
    </>
  )
}

/** The setup code proves ownership; the admin password becomes the device's master key. */
export function ClaimStep({ onClaimed }: { onClaimed: () => void }) {
  const [code, setCode] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ready = code.trim() !== "" && validPassword(password) && password === confirm

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await postJson("/api/bootstrap/claim", { code, password })
      if (res.ok) {
        onClaimed()
        return
      }
      setError(res.message ?? `claiming failed (${res.status})`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Claim your device</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The setup code proves this device is yours. Then set the admin password — the master
        key for this device, and the default admin password of apps that ship one. Keep it
        somewhere safe.
      </p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <SetupCodeField id="claim-code" value={code} onChange={setCode} />
        <PasswordFields idPrefix="claim" label="Admin password" password={password} confirm={confirm}
          setPassword={setPassword} setConfirm={setConfirm} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || !ready}>{busy ? "Claiming…" : "Claim this device"}</Button>
      </form>
    </section>
  )
}

/** Claimed, but this browser isn't part of the setup yet (a new browser, or its
 *  setup cookie expired): the setup code lets it back in. */
export function ResumeScreen({ onResumed }: { onResumed: () => void }) {
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await postJson("/api/bootstrap/resume", { code })
      if (res.ok) {
        onResumed()
        return
      }
      setError(res.message ?? `checking the code failed (${res.status})`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Continue setting up</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This device is claimed, but setup isn't finished — and this browser isn't part of it
        yet. Enter the setup code to pick up where you left off.
      </p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <SetupCodeField id="resume-code" value={code} onChange={setCode} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || code.trim() === ""}>{busy ? "Checking…" : "Continue"}</Button>
      </form>
    </section>
  )
}

/** The personal account for daily sign-in. After a reset, the account from before
 *  can be kept — optionally with a new password (the forgotten-password recovery). */
export function AccountStep({ baseDomain, previousAccount, onDone, onSessionLost }: {
  baseDomain: string
  previousAccount: string | null
  onDone: () => void
  onSessionLost: () => void
}) {
  const [mode, setMode] = useState<"keep" | "new">(previousAccount ? "keep" : "new")
  const [username, setUsername] = useState("")
  const [changePassword, setChangePassword] = useState(false)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const keeping = mode === "keep" && previousAccount != null
  const name = keeping ? (previousAccount ?? "") : username
  const needsPassword = !keeping || changePassword
  const ready =
    USERNAME.test(name) && name !== "admin" && (!needsPassword || (validPassword(password) && password === confirm))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await postJson("/api/bootstrap/account", needsPassword ? { username: name, password } : { username: name })
      if (res.ok) {
        onDone()
        return
      }
      if (res.status === 401) {
        onSessionLost()
        return
      }
      setError(res.message ?? `saving the account failed (${res.status})`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Create your account</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This is how you sign in every day — here and in every app you install. Keep{" "}
        <span className="font-mono">admin</span> for emergencies.
      </p>
      {previousAccount && (
        <fieldset className="mt-4 space-y-2 text-sm">
          <legend className="sr-only">Account</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="account-mode" checked={mode === "keep"} onChange={() => setMode("keep")} />
            Keep <span className="font-mono">{previousAccount}</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="account-mode" checked={mode === "new"} onChange={() => setMode("new")} />
            Create a different account
          </label>
        </fieldset>
      )}
      <form className="mt-6 space-y-4" onSubmit={submit}>
        {keeping ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={changePassword} onChange={(e) => setChangePassword(e.target.checked)} />
            Set a new password for {previousAccount}
          </label>
        ) : (
          <div>
            <label htmlFor="account-username" className="text-sm font-medium">Username</label>
            <Input id="account-username" className="mt-1" autoComplete="username" autoCapitalize="none"
              spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
            <p className="mt-1 text-xs text-muted-foreground">
              Lowercase letters, digits, dots and dashes. You will sign in as{" "}
              <span className="font-mono">{username || "name"}@{baseDomain}</span>.
            </p>
          </div>
        )}
        {needsPassword && (
          <PasswordFields idPrefix="account" label="Password" password={password} confirm={confirm}
            setPassword={setPassword} setConfirm={setConfirm} />
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || !ready}>
          {busy ? "Saving…" : keeping ? "Continue" : "Create account"}
        </Button>
      </form>
    </section>
  )
}
