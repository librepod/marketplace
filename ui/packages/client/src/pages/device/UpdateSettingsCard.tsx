import { useState } from "react"
import type { DeviceView } from "@librepod/shared"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { useDeviceWrite } from "@/hooks/useDevice"

type Channel = "stable" | "beta"
const CHANNEL_LABEL: Record<Channel, string> = { stable: "Stable", beta: "Beta" }

function zonesWith(current: string): string[] {
  const list = Intl.supportedValuesOf("timeZone")
  // The device's own zone may be missing from the browser's list (a renamed zone).
  return list.includes(current) ? list : [current, ...list]
}

function SettingsDialog({ device, onClose }: { device: DeviceView; onClose: () => void }) {
  const s = device.update?.settings
  const [channel, setChannel] = useState<Channel>(s?.channel ?? "stable")
  const [auto, setAuto] = useState(s?.auto ?? true)
  const [timezone, setTimezone] = useState(s?.timezone ?? "UTC")
  const write = useDeviceWrite()
  const save = () =>
    write.mutate(
      { path: "update-settings", method: "PUT", body: { channel, auto, timezone } },
      { onSuccess: onClose },
    )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update settings</DialogTitle>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Channel</legend>
          {([["stable", "Stable — recommended"], ["beta", "Beta — early versions, may break"]] as const).map(([value, text]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input type="radio" name="channel" checked={channel === value} onChange={() => setChannel(value)} />
              {text}
            </label>
          ))}
        </fieldset>
        <div className="flex items-center justify-between text-sm">
          <label htmlFor="auto-updates">Automatic updates</label>
          <Switch id="auto-updates" aria-label="Automatic updates" checked={auto} onCheckedChange={setAuto} />
        </div>
        <div className="space-y-1 text-sm">
          <label htmlFor="update-timezone" className="font-medium">Time zone</label>
          <select
            id="update-timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="h-8 w-full rounded-lg border border-input bg-background px-2"
          >
            {zonesWith(s?.timezone ?? timezone).map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
        {write.isError && <p className="text-sm text-destructive">{write.error.message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={write.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function UpdateSettingsCard({ device }: { device: DeviceView }) {
  const [open, setOpen] = useState(false)
  const s = device.update?.settings
  const refused = !device.pending.updates && device.rejected.updates
  const rows: Array<[string, string]> = [
    ["Channel", s?.channel ? CHANNEL_LABEL[s.channel] : "—"],
    ["Automatic updates", s?.auto === undefined ? "—" : s.auto ? "On" : "Off"],
    ["Time zone", s?.timezone ?? "—"],
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Update settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="space-y-1 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <Button variant="outline" disabled={device.pending.updates} onClick={() => setOpen(true)}>Change</Button>
        {device.pending.updates && <p className="text-sm text-muted-foreground">Sending to the device…</p>}
        {refused && <p className="text-sm text-destructive">The device refused your change: {refused}</p>}
        {open && <SettingsDialog device={device} onClose={() => setOpen(false)} />}
      </CardContent>
    </Card>
  )
}
