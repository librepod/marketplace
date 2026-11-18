import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Power, RotateCcw } from "lucide-react"
import type { DeviceView } from "@librepod/shared"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useDeviceWrite } from "@/hooks/useDevice"

export const GOING_DOWN_MAX_MS = 5 * 60_000

type Action = "reboot" | "poweroff"
const COPY = {
  reboot: {
    noun: "restart", label: "Restart", title: "Restart your LibrePod?",
    body: "Your apps will be unavailable for a few minutes while it restarts.",
    going: "Restarting… this page reconnects by itself",
  },
  poweroff: {
    noun: "power off", label: "Power off", title: "Power off your LibrePod?",
    body: "Your apps will stop, and someone has to be at the device to turn it back on.",
    going: "Shutting down…",
  },
} as const

export function PowerControls({ device }: { device: DeviceView }) {
  const write = useDeviceWrite()
  const [sent, setSent] = useState<Action | null>(null)
  const [asking, setAsking] = useState<Action | null>(null) // AlertDialogAction doesn't close by itself
  const [down, setDown] = useState<{ action: Action; reportedAt: string | null } | null>(null)
  const prevPending = useRef(device.pending.power)
  const sentAt = useRef(0)
  const client = useQueryClient()

  // This tab's answer was taken by the device without a refusal: it is going down —
  // unless polls failed since sending, i.e. it already went down and is back.
  useEffect(() => {
    if (sent && prevPending.current && !device.pending.power && !device.rejected.power) {
      const missed = (client.getQueryState(["device"])?.errorUpdatedAt ?? 0) > sentAt.current
      if (!missed) setDown({ action: sent, reportedAt: device.reportedAt })
      setSent(null)
    }
    prevPending.current = device.pending.power
  }, [client, device.pending.power, device.rejected.power, device.reportedAt, sent])

  // Back once it reports again (a newer reportedAt), or after a cap.
  useEffect(() => {
    if (!down) return
    if (device.reportedAt !== down.reportedAt) return setDown(null)
    const t = setTimeout(() => setDown(null), GOING_DOWN_MAX_MS)
    return () => clearTimeout(t)
  }, [down, device.reportedAt])

  const blocked =
    !device.reporting || device.update?.state === "installing" || device.pending.power || down !== null || write.isPending
  const refused = !device.pending.power && device.rejected.power
  const send = (action: Action) => {
    sentAt.current = Date.now()
    setSent(action)
    write.mutate(
      { path: "power", method: "POST", body: { action } },
      {
        // The agent can act within milliseconds, so the write's own response may already
        // show the answer handled; a poll that sees pending flip would never happen.
        onSuccess: (info) => {
          if (info.os === "present" && !info.device.pending.power && !info.device.rejected.power) {
            setDown({ action, reportedAt: info.device.reportedAt })
            setSent(null)
          }
        },
      },
    )
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {(["reboot", "poweroff"] as const).map((action) => (
          <AlertDialog key={action} open={asking === action} onOpenChange={(o) => setAsking(o ? action : null)}>
            <AlertDialogTrigger
              render={
                <Button variant="outline" disabled={blocked}>
                  {action === "reboot" ? <RotateCcw aria-hidden /> : <Power aria-hidden />}
                  {COPY[action].label}
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{COPY[action].title}</AlertDialogTitle>
                <AlertDialogDescription>{COPY[action].body}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => { setAsking(null); send(action) }}>{COPY[action].label}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ))}
      </div>
      {down && <p className="text-sm text-muted-foreground">{COPY[down.action].going}</p>}
      {write.isError && <p className="text-sm text-destructive">{write.error.message}</p>}
      {refused && !down && (
        <p className="text-sm text-destructive">
          The device refused your {sent ? COPY[sent].noun : "power request"}: {refused}.
        </p>
      )}
    </div>
  )
}
