import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react"
import { Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react"
import type {
  AppComponent,
  AppSettingItem,
  AppSettings,
  AppSettingsValues,
  CatalogApp,
  InstallRequest,
} from "@librepod/shared"
import { useConfig } from "@/hooks/useConfig"
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
import { useAppSettings } from "@/hooks/useAppSettings"
import type { InstallError } from "@/hooks/useInstallApp"

/**
 * Install (POST) or save settings (PUT): only what the dialog uses, so both hooks fit (their
 * variable types differ, which react-query's own result types won't let one type cover).
 */
interface SettingsMutation {
  mutate: (request: InstallRequest, options: { onSuccess: () => void }) => void
  isPending: boolean
  error: InstallError | null
}
type Mode = "install" | "edit"

const COPY = {
  install: { submit: "Install", pending: "Installing..." },
  edit: { submit: "Save", pending: "Saving..." },
} as const

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

/** Whether the app lists shared components: the install dialog opens for them even with no questions. */
export function hasComponents(app?: CatalogApp): boolean {
  return (app?.components?.length ?? 0) > 0
}

/** What a component asks in the dialog: its settings, then its install values (always required). */
function componentFields(component: AppComponent): AppSettingItem[] {
  return [
    ...(component.settings ?? []).filter((item) => !item.generate),
    ...component.values
      .filter((v) => v.from === "install")
      .map((v) => ({ name: v.name, label: v.label, description: v.description, required: true, default: v.default })),
  ]
}

/** A bare YAML `default:` is null: no default, never the text "null". */
const hasDefault = (item: AppSettingItem) => item.default !== undefined && item.default !== null

/**
 * A switch always has an answer, so a boolean without a default starts as "false".
 * `${BASE_DOMAIN}` in a default is expanded with the device's own domain (the server does
 * the same on save, so an untouched or stale prefill still stores the resolved URL).
 */
function initialValue(item: AppSettingItem, baseDomain?: string): string {
  if (hasDefault(item)) {
    const value = String(item.default)
    return baseDomain ? value.replaceAll("${BASE_DOMAIN}", baseDomain) : value
  }
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

const textareaClass =
  "flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm text-foreground shadow-sm transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"

/** Multi-line answer (a pasted config). Sensitive ones are masked like a password field. */
function TextArea({
  id,
  value,
  onChange,
  invalid,
  describedBy,
  sensitive,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  invalid?: boolean
  describedBy?: string
  sensitive?: boolean
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex min-w-0 flex-1 gap-1">
      <textarea
        id={id}
        rows={6}
        className={textareaClass}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // shortcut: browsers without -webkit-text-security show it unmasked, upgrade if that matters
        style={sensitive && !shown ? ({ WebkitTextSecurity: "disc" } as CSSProperties) : undefined}
      />
      {sensitive && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={shown ? "Hide value" : "Show value"}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff /> : <Eye />}
        </Button>
      )}
    </div>
  )
}

function QuestionField({
  item,
  value,
  onChange,
  error,
  idPrefix = "setting",
}: {
  item: AppSettingItem
  value: string
  onChange: (value: string) => void
  error?: string
  idPrefix?: string
}) {
  const id = `${idPrefix}-${item.name}`
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
  } else if (type === "text") {
    control = (
      <TextArea
        id={id}
        value={value}
        onChange={onChange}
        invalid={!!error}
        describedBy={describedBy}
        sensitive={item.sensitive}
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

/** Layout units: one per group (radios, members in catalog order) and one per ungrouped component. */
function componentBlocks(components: AppComponent[]): Array<{ group?: string; members: AppComponent[] }> {
  const blocks: Array<{ group?: string; members: AppComponent[] }> = []
  for (const c of components) {
    const existing = c.group ? blocks.find((b) => b.group === c.group) : undefined
    if (existing) existing.members.push(c)
    else blocks.push({ group: c.group, members: [c] })
  }
  return blocks
}

function InstallForm({
  app,
  stored,
  mutation,
  mode,
  onClose,
  baseDomain,
}: {
  app: CatalogApp
  stored: AppSettingsValues
  mutation: SettingsMutation
  mode: Mode
  onClose: () => void
  baseDomain?: string
}) {
  const settings = app.settings ?? {}
  // Generated items are machine-made secrets the server resolves — the dialog never asks.
  // filter() already returns a fresh array, so sort cannot mutate the catalog's own list.
  const items = (settings.items ?? [])
    .filter((item) => !item.generate)
    .sort((a, b) => Number(!!b.required) - Number(!!a.required))
  // Stored answer first (a reinstall or an edit starts from what is saved), then the default.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((item) => [item.name, stored.settings[item.name] ?? initialValue(item, baseDomain)])),
  )
  const [rows, setRows] = useState<CustomRow[]>(() => stored.custom.map((v, i) => ({ id: i + 1, ...v })))
  const [nextRowId, setNextRowId] = useState(stored.custom.length + 1)
  // Ids of the rows sent last, in order: maps a server "custom.<i>" error back to its row.
  const [sentRowIds, setSentRowIds] = useState<number[]>([])
  const [customOpen, setCustomOpen] = useState(stored.custom.length > 0)

  // Shared components are picked at install only; an installed app's are fixed.
  const offered = mode === "install" ? (app.components ?? []) : []
  const [picked, setPicked] = useState<string[]>([])
  const [componentValues, setComponentValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(offered.flatMap((c) => componentFields(c).map((item) => [`${c.name}.${item.name}`, initialValue(item, baseDomain)]))),
  )
  const chosen = offered.filter((c) => picked.includes(c.name))
  const toggleComponent = (name: string, on: boolean) =>
    setPicked((current) => (on ? [...current, name] : current.filter((n) => n !== name)))
  // One component per group: swap the group's pick (or clear it with null).
  const pickInGroup = (group: string, name: string | null) =>
    setPicked((current) => [
      ...current.filter((n) => offered.find((c) => c.name === n)?.group !== group),
      ...(name ? [name] : []),
    ])

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
    const component = /^components\.([^.]+)\.(.+)$/.exec(name)
    if (component) {
      return chosen.some((c) => c.name === component[1] && componentFields(c).some((item) => item.name === component[2]))
    }
    if (items.some((item) => item.name === name)) return true
    if (!settings.allowCustom) return false
    if (name === "custom") return true
    const match = /^custom\.(\d+)$/.exec(name)
    return match !== null && rows.some((row) => row.id === sentRowIds[Number(match[1])])
  }
  const unplacedErrors = (error?.fieldErrors ?? []).filter((e) => !isShownByField(e.name))

  const renderComponentFields = (c: AppComponent) => (
    <div className="grid gap-3 pl-6">
      {componentFields(c).map((item) => (
        <QuestionField
          key={item.name}
          item={item}
          idPrefix={`setting-${c.name}`}
          value={componentValues[`${c.name}.${item.name}`] ?? ""}
          onChange={(value) => setComponentValues((current) => ({ ...current, [`${c.name}.${item.name}`]: value }))}
          error={fieldErrors.get(`components.${c.name}.${item.name}`)}
        />
      ))}
    </div>
  )

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
    if (chosen.length > 0) {
      const answer = (c: AppComponent, name: string) => componentValues[`${c.name}.${name}`] ?? ""
      request.components = chosen.map((c) => ({
        name: c.name,
        settings: Object.fromEntries((c.settings ?? []).filter((i) => !i.generate).map((i) => [i.name, answer(c, i.name)])),
        values: Object.fromEntries(c.values.filter((v) => v.from === "install").map((v) => [v.name, answer(c, v.name)])),
      }))
    }
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

      {offered.length > 0 && (
        <fieldset className="grid gap-3 rounded-md border border-input px-3 py-2">
          <legend className="px-1 text-sm font-medium">Components</legend>
          {componentBlocks(offered).map((block) =>
            block.group ? (
              <div key={block.group} role="radiogroup" aria-label={humanize(block.group)} className="grid gap-2">
                <p className="text-xs font-medium text-muted-foreground">{humanize(block.group)}</p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`component-group-${block.group}`}
                    checked={!block.members.some((c) => picked.includes(c.name))}
                    onChange={() => pickInGroup(block.group!, null)}
                  />
                  None
                </label>
                {block.members.map((c) => (
                  <div key={c.name} className="grid gap-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`component-group-${block.group}`}
                        checked={picked.includes(c.name)}
                        onChange={() => pickInGroup(block.group!, c.name)}
                      />
                      {c.displayName}
                    </label>
                    <p className="pl-6 text-xs text-muted-foreground">{c.description}</p>
                    {picked.includes(c.name) && renderComponentFields(c)}
                  </div>
                ))}
              </div>
            ) : (
              <div key={block.members[0].name} className="grid gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.includes(block.members[0].name)}
                    onChange={(e) => toggleComponent(block.members[0].name, e.target.checked)}
                  />
                  {block.members[0].displayName}
                </label>
                <p className="pl-6 text-xs text-muted-foreground">{block.members[0].description}</p>
                {picked.includes(block.members[0].name) && renderComponentFields(block.members[0])}
              </div>
            ),
          )}
        </fieldset>
      )}

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
          {mutation.isPending ? COPY[mode].pending : COPY[mode].submit}
        </Button>
      </DialogFooter>
    </form>
  )
}

const NO_STORED: AppSettingsValues = { settings: {}, custom: [] }

/**
 * The form once the stored settings are loaded. Never a form without them: saving one built
 * from defaults alone would wipe the user's values.
 */
function SettingsBody({
  app,
  mutation,
  mode,
  onClose,
}: {
  app: CatalogApp
  mutation: SettingsMutation
  mode: Mode
  onClose: () => void
}) {
  // An app with components but no questions has no settings entry to read (the endpoint 404s).
  const stored = useAppSettings(app.name, !!app.settings)
  // The device's own domain expands ${BASE_DOMAIN} in default prefills. The form waits for it
  // (cached for the session, so only the first dialog pays) so a prefill shows the resolved
  // value; if /api/config fails it renders anyway and the server's substitution on save still
  // stores the resolved value.
  const config = useConfig()
  const domainReady = config.isSuccess || config.isError
  const baseDomain = config.data?.baseDomain
  if (!app.settings && domainReady)
    return <InstallForm app={app} stored={NO_STORED} mutation={mutation} mode={mode} onClose={onClose} baseDomain={baseDomain} />
  if (stored.data && domainReady)
    return <InstallForm app={app} stored={stored.data} mutation={mutation} mode={mode} onClose={onClose} baseDomain={baseDomain} />
  if (stored.isError) {
    return (
      <div className="grid gap-4">
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Couldn't load the current settings. Try again in a minute.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </div>
    )
  }
  return (
    <div className="flex justify-center py-8">
      <Loader2 aria-label="Loading settings" className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )
}

/**
 * Asks an app's install questions (catalog `settings`), prefilled from the stored entry:
 * before installing (`install`) or to change an installed app (`edit`). The form lives
 * inside the dialog content, so closing the dialog discards what was typed.
 */
export function InstallDialog({
  app,
  open,
  onOpenChange,
  mutation,
  mode = "install",
}: {
  app: CatalogApp
  open: boolean
  onOpenChange: (open: boolean) => void
  mutation: SettingsMutation
  mode?: Mode
}) {
  // Never close mid-request: the outcome must land somewhere visible.
  const handleOpenChange = (next: boolean) => {
    if (!mutation.isPending) onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "edit" ? `${app.displayName} settings` : `Install ${app.displayName}`}</DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? "The app picks up saved settings the next time it starts."
              : "Fill in what the app needs, then install."}
          </DialogDescription>
        </DialogHeader>
        <SettingsBody app={app} mutation={mutation} mode={mode} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
