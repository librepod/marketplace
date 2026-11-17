import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import type { DeviceView } from "@librepod/shared"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useDeviceWrite } from "@/hooks/useDevice"
import { keyLabel } from "./format"

// Same shape the server and the CRD enforce: a key type first, no options.
const KEY_PATTERN = /^[a-z0-9@.-]+ AAAA[A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/
const MAX_KEYS = 32
const identity = (k: string) => k.split(" ").slice(0, 2).join(" ") // type + base64, not the comment

function problem(raw: string, keys: string[]): string | null {
  const key = raw.trim()
  if (/[\r\n]/.test(key)) return "Paste one key at a time"
  if (!KEY_PATTERN.test(key)) return "That doesn't look like a public key (it should start with ssh-ed25519, ssh-rsa or similar)"
  if (keys.some((k) => identity(k) === identity(key))) return "That key is already on the list"
  if (keys.length >= MAX_KEYS) return `A LibrePod holds at most ${MAX_KEYS} keys`
  return null
}

function AddKeyDialog({ keys, onSave, onClose }: { keys: string[]; onSave: (k: string[]) => void; onClose: () => void }) {
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const add = () => {
    const err = problem(text, keys)
    if (err) return setError(err)
    onSave([...keys, text.trim()])
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an SSH key</DialogTitle>
        </DialogHeader>
        <label htmlFor="ssh-key" className="text-sm font-medium">Public key</label>
        <textarea
          id="ssh-key"
          rows={4}
          value={text}
          onChange={(e) => { setText(e.target.value); setError(null) }}
          placeholder="ssh-ed25519 AAAA… you@laptop"
          className="w-full rounded-lg border border-input bg-background p-2 font-mono text-xs"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={add} disabled={!text.trim()}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SshKeysCard({ device }: { device: DeviceView }) {
  const write = useDeviceWrite()
  const [adding, setAdding] = useState(false)
  const [removingLast, setRemovingLast] = useState(false)
  const keys = device.sshKeys
  const locked = device.pending.sshKeys || write.isPending
  const save = (next: string[]) => write.mutate({ path: "ssh-keys", method: "PUT", body: { keys: next } })
  const remove = (i: number) => (keys.length === 1 ? setRemovingLast(true) : save(keys.filter((_, j) => j !== i)))
  const refused = !device.pending.sshKeys && device.rejected.sshKeys

  return (
    <Card>
      <CardHeader>
        <CardTitle>SSH keys</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">These keys can log in as librepod. With none, SSH is off.</p>
        <ul className="divide-y">
          {keys.map((key, i) => {
            const { type, name } = keyLabel(key)
            return (
              <li key={key} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-mono text-xs text-muted-foreground">{type}</span> {name}
                </span>
                <Button variant="ghost" size="icon" aria-label={`Remove ${name}`} disabled={locked} onClick={() => remove(i)}>
                  <Trash2 aria-hidden />
                </Button>
              </li>
            )
          })}
        </ul>
        <Button variant="outline" disabled={locked} onClick={() => setAdding(true)}>
          <Plus aria-hidden /> Add key
        </Button>
        {device.pending.sshKeys && <p className="text-sm text-muted-foreground">Sending to the device…</p>}
        {refused && <p className="text-sm text-destructive">The device refused your key list: {refused}</p>}
        {write.isError && <p className="text-sm text-destructive">{write.error.message}</p>}
        {adding && <AddKeyDialog keys={keys} onSave={save} onClose={() => setAdding(false)} />}
        <AlertDialog open={removingLast} onOpenChange={setRemovingLast}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove the last key?</AlertDialogTitle>
              <AlertDialogDescription>SSH will be off; only the console can log in.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => { setRemovingLast(false); save([]) }}>Remove key</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}
