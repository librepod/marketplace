import { useState, type FormEvent, type ReactNode } from "react"
import { Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react"
import type { AppSettingItem, AppSettings, CatalogApp, InstallRequest } from "@librepod/shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { useInstallApp } from "@/hooks/useInstallApp"

type InstallMutation = ReturnType<typeof useInstallApp>

interface CustomRow {
  id: number
  name: string
  value: string
}

/** "RENOVATE_TOKEN" → "Renovate token": the label when a question has none. */
export function humanize(name: string): string {
  const words = name.toLowerCase().replace(/_+/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Whether the install dialog has anything to ask: at least one question item (generated
 * ones are never asked) or the custom-variables offer. Generated-only apps stay one-click —
 * an empty dialog would only add a pointless step.
 */
export function hasInstallQuestions(settings?: AppSettings): boolean {
  if (!settings) return false
  if (settings.allowCustom) return true
  return (settings.items ?? []).some((item) => !item.generate)
}

/** A bare YAML `default:` is null: no default, never the text "null". */
const hasDefault = (item: AppSettingItem) => item.default !== undefined && item.default !== null

/** A switch always has an answer, so a boolean without a default starts as "false". */
function initialValue(item: AppSettingItem): string {
  if (hasDefault(item)) return String(item.default)
  return item.type === "boolean" ? "false" : ""
}

// Same control language as <Input>.
const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-sm transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"

function MaskedInput({
  id,
  label,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id?: string
  label?: string
  value: string
  onChange: (value: string) => void
  invalid?: boolean
  describedBy?: string
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex min-w-0 flex-1 gap-1">
      <Input
        id={id}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={shown ? "Hide value" : "Show value"}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  )
}

function QuestionField({
  item,
  value,
  onChange,
  error,
}: {
  item: AppSettingItem
  value: string
  onChange: (value: string) => void
  error?: string
}) {
  const id = `setting-${item.name}`
  const label = item.label ?? humanize(item.name)
  const type = item.type ?? "string"
  const describedBy =
    [item.description && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined

  let control: ReactNode
  if (type === "boolean") {
    control = (
      <Switch
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        checked={value === "true"}
        onCheckedChange={(checked: boolean) => onChange(checked ? "true" : "false")}
      />
    )
  } else if (item.options) {
    control = (
      <select
        id={id}
        className={selectClass}
        aria-invalid={!!error || undefined}
        aria-describedby={describedBy}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {!item.required ? (
          <option value="">Not set</option>
        ) : (
          !hasDefault(item) && <option value="">Choose…</option>
        )}
        {item.options.map(String).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  } else if (item.sensitive) {
    control = <MaskedInput id={id} value={value} onChange={onChange} invalid={!!error} describedBy={describedBy} />
  } else {
    control = (
      <Input
        id={id}
        inputMode={type === "number" ? "decimal" : undefined}
        aria-invalid={!!error || undefined}
        aria-describedby={describedBy}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {!item.required && type !== "boolean" && (
          <span className="font-normal text-muted-foreground"> (optional)</span>
        )}
      </label>
      {control}
      {item.description && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {item.description}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function InstallForm({
  app,
  mutation,
  onClose,
}: {
  app: CatalogApp
  mutation: InstallMutation
  onClose: () => void
}) {
  const settings = app.settings ?? {}
  // Generated items are machine-made secrets the server resolves — the dialog never asks.
  // filter() already returns a fresh array, so sort cannot mutate the catalog's own list.
  const items = (settings.items ?? [])
    .filter((item) => !item.generate)
    .sort((a, b) => Number(!!b.required) - Number(!!a.required))
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((item) => [item.name, initialValue(item)])),
  )
  const [rows, setRows] = useState<CustomRow[]>([])
  const [nextRowId, setNextRowId] = useState(1)
  // Ids of the rows sent last, in order: maps a server "custom.<i>" error back to its row.
  const [sentRowIds, setSentRowIds] = useState<number[]>([])
  const [customOpen, setCustomOpen] = useState(false)

  const error = mutation.error
  const fieldErrors = new Map((error?.fieldErrors ?? []).map((e) => [e.name, e.message]))
  const rowError = (id: number) => {
    const index = sentRowIds.indexOf(id)
    return index === -1 ? undefined : fieldErrors.get(`custom.${index}`)
  }
  const hasCustomErrors = [...fieldErrors.keys()].some((name) => name === "custom" || name.startsWith("custom."))
  // Errors no field below can show: whole-request ones ("settings") or names this form
  // doesn't render (e.g. the catalog changed while the dialog was open). They go in the alert.
  const isShownByField = (name: string) => {
    if (items.some((item) => item.name === name)) return true
    if (!settings.allowCustom) return false
    if (name === "custom") return true
    const match = /^custom\.(\d+)$/.exec(name)
    return match !== null && rows.some((row) => row.id === sentRowIds[Number(match[1])])
  }
  const unplacedErrors = (error?.fieldErrors ?? []).filter((e) => !isShownByField(e.name))

  const updateRow = (id: number, patch: Partial<CustomRow>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))

  const addRow = () => {
    setRows((current) => [...current, { id: nextRowId, name: "", value: "" }])
    setNextRowId((id) => id + 1)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    // Rows left completely blank are dropped, not sent.
    const sent = rows.filter((row) => row.name.trim() !== "" || row.value !== "")
    setSentRowIds(sent.map((row) => row.id))
    // Every answer is sent, empty ones too: the server fills in a default only for a question
    // left out, so an optional field the user cleared stays unset instead of reverting.
    const request: InstallRequest = { settings: values }
    if (sent.length > 0) request.custom = sent.map((row) => ({ name: row.name.trim(), value: row.value }))
    mutation.mutate(request, { onSuccess: onClose })
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      {error && (
        <div role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <p>{error.message}</p>
          {unplacedErrors.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {unplacedErrors.map((e) => (
                <li key={e.name}>{e.name === "settings" ? e.message : `${e.name}: ${e.message}`}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {items.map((item) => (
        <QuestionField
          key={item.name}
          item={item}
          value={values[item.name] ?? ""}
          onChange={(value) => setValues((current) => ({ ...current, [item.name]: value }))}
          error={fieldErrors.get(item.name)}
        />
      ))}

      {settings.allowCustom && (
        <details
          open={customOpen || hasCustomErrors}
          onToggle={(e) => setCustomOpen(e.currentTarget.open)}
          className="rounded-md border border-input px-3 py-2"
        >
          <summary className="cursor-pointer text-sm font-medium">Custom environment variables</summary>
          <div className="mt-3 grid gap-3">
            <p className="text-xs text-muted-foreground">
              For advanced users. Adds variables or overrides built-in ones — this may break the app.
            </p>
            {fieldErrors.get("custom") && <p className="text-xs text-destructive">{fieldErrors.get("custom")}</p>}
            {rows.map((row) => (
              <div key={row.id} className="grid gap-1">
                <div className="flex gap-1">
                  <Input
                    aria-label="Variable name"
                    placeholder="NAME"
                    className="w-2/5 font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    value={row.name}
                    onChange={(e) => updateRow(row.id, { name: e.target.value })}
                  />
                  <MaskedInput label="Variable value" value={row.value} onChange={(value) => updateRow(row.id, { value })} />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove variable"
                    onClick={() => setRows((current) => current.filter((r) => r.id !== row.id))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                {rowError(row.id) && <p className="text-xs text-destructive">{rowError(row.id)}</p>}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={addRow}>
              <Plus /> Add variable
            </Button>
          </div>
        </details>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {mutation.isPending ? "Installing..." : "Install"}
        </Button>
      </DialogFooter>
    </form>
  )
}

/**
 * Asks an app's install questions (catalog `settings`) before installing. The form lives
 * inside the dialog content, so closing the dialog discards what was typed.
 */
export function InstallDialog({
  app,
  open,
  onOpenChange,
  installMutation,
}: {
  app: CatalogApp
  open: boolean
  onOpenChange: (open: boolean) => void
  installMutation: InstallMutation
}) {
  // Never close mid-request: the outcome must land somewhere visible.
  const handleOpenChange = (next: boolean) => {
    if (!installMutation.isPending) onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install {app.displayName}</DialogTitle>
          <DialogDescription>Fill in what the app needs, then install.</DialogDescription>
        </DialogHeader>
        <InstallForm app={app} mutation={installMutation} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
