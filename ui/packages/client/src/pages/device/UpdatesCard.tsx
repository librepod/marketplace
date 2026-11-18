import type { DeviceView } from "@librepod/shared"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useDeviceWrite } from "@/hooks/useDevice"

type Action = "now" | "tonight" | "now-instead" | "retry" | "try-again"

interface Headline { text: string; actions: Action[] }

function headline(device: DeviceView): Headline {
  const u = device.update
  if (!u) return { text: "Checking for updates…", actions: [] }
  const { available, current, state } = u
  const retry: Action[] = available ? ["retry"] : []
  if (state === "ready" && available && u.failedVersions?.includes(available)) {
    return { text: `${available} failed last time — try again`, actions: ["now", "tonight"] }
  }
  // Every status field is optional (older LibrePod OS), so never print "undefined".
  const next = available ?? "an update"
  const Next = available ?? "An update"
  const fallback = { text: state ? `Update status: ${state}` : "Update status unknown", actions: [] }
  switch (state) {
    case "up-to-date": return { text: "Up to date", actions: [] }
    case "downloading": return { text: `Downloading ${next}`, actions: [] }
    case "ready": return { text: `${Next} is ready to install`, actions: ["now", "tonight"] }
    case "scheduled": return { text: `${Next} installs tonight at ${u.installAt?.slice(11, 16) ?? "—"}`, actions: ["now-instead"] }
    case "installing": return { text: `Installing ${next}`, actions: [] }
    case "done": return { text: current ? `Updated to ${current}` : "Updated", actions: [] }
    case "rolled-back":
      return available
        ? { text: `${available} didn't start, so ${current ?? "the previous version"} is back`, actions: retry }
        : fallback
    case "failed":
      return available ? { text: `${available} didn't install`, actions: ["try-again"] } : fallback
    default: return fallback
  }
}

export function UpdatesCard({ device }: { device: DeviceView }) {
  const write = useDeviceWrite()
  const { text, actions } = headline(device)
  const available = device.update?.available
  const blocked = !device.reporting || device.pending.install || write.isPending
  const send = (when: "now" | "tonight") => write.mutate({ path: "install", method: "POST", body: { when } })
  const label: Record<Action, string> = {
    now: "Install now", tonight: "Install tonight", "now-instead": "Install now instead",
    retry: `Try ${available} again`, "try-again": "Try again",
  }
  const refused = !device.pending.install && device.rejected.install

  return (
    <Card>
      <CardHeader>
        <CardTitle>Updates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-base font-medium">{text}</p>
        {device.update?.detail && <p className="text-sm text-muted-foreground">{device.update.detail}</p>}
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <Button
                key={a}
                variant={a === "tonight" ? "outline" : "default"}
                disabled={blocked}
                onClick={() => send(a === "tonight" ? "tonight" : "now")}
              >
                {label[a]}
              </Button>
            ))}
          </div>
        )}
        {actions.includes("tonight") && device.update?.settings?.timezone && (
          <p className="text-xs text-muted-foreground">tonight = 02:00–05:00, {device.update.settings.timezone}</p>
        )}
        {device.pending.install && <p className="text-sm text-muted-foreground">Sending to the device…</p>}
        {refused && <p className="text-sm text-destructive">The device refused your install: {refused}</p>}
        {write.isError && <p className="text-sm text-destructive">{write.error.message}</p>}
      </CardContent>
    </Card>
  )
}
