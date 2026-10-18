import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AppSettingsValues, CatalogApp } from '@librepod/shared'
import { toast } from 'sonner'
import { useInstallApp } from '@/hooks/useInstallApp'
import { useSaveSettings } from '@/hooks/useSaveSettings'
import { InstallDialog, hasInstallQuestions, humanize } from './InstallDialog'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const app: CatalogApp = {
  name: 'renovate',
  displayName: 'Renovate',
  description: 'Dependency updates',
  category: 'Automation',
  version: '41.0.0',
  icon: 'https://example.com/renovate.png',
  sourceType: 'oci-kustomize',
  sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/renovate',
  settings: {
    allowCustom: true,
    items: [
      { name: 'LOG_FORMAT', options: ['json', 'pretty'], default: 'json' },
      { name: 'RENOVATE_TOKEN', label: 'Access token', description: 'Personal access token', sensitive: true, required: true },
      { name: 'DRY_RUN', type: 'boolean', default: false },
    ],
  },
}

function Harness({ app: subject, mode }: { app: CatalogApp; mode?: 'install' | 'edit' }) {
  const install = useInstallApp(subject.name, subject.displayName)
  const save = useSaveSettings(subject.name, subject.displayName)
  const [open, setOpen] = useState(true)
  return (
    <>
      <button onClick={() => setOpen(true)}>reopen</button>
      <InstallDialog
        app={subject}
        open={open}
        onOpenChange={setOpen}
        mutation={mode === 'edit' ? save : install}
        mode={mode}
      />
    </>
  )
}

function renderDialog(subject: CatalogApp = app, mode?: 'install' | 'edit') {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <Harness app={subject} mode={mode} />
    </QueryClientProvider>,
  )
}

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response

/** GET /api/apps/renovate/settings answers `stored`; any other method answers `submit`. */
function mockApi({
  stored = { settings: {}, custom: [] },
  storedStatus = 200,
  submit = reply({ success: true, message: 'ok' }),
}: { stored?: AppSettingsValues; storedStatus?: number; submit?: Response | Promise<Response> } = {}) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    if ((init?.method ?? 'GET') !== 'GET') return submit
    expect(input).toBe('/api/apps/renovate/settings')
    return reply(stored, storedStatus)
  })
}

type FetchSpy = { mock: { calls: unknown[][] } }
const submits = (spy: FetchSpy) =>
  spy.mock.calls.filter((call) => ((call[1] as RequestInit | undefined)?.method ?? 'GET') !== 'GET')
const sentBody = (spy: FetchSpy) => JSON.parse((submits(spy)[0][1] as RequestInit).body as string)

beforeEach(() => {
  vi.resetAllMocks()
  // sonner/base-ui may read matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  })
})

describe('humanize', () => {
  it('turns an env var name into a label', () => {
    expect(humanize('RENOVATE_GITHUB_COM_TOKEN')).toBe('Renovate github com token')
  })
})

describe('hasInstallQuestions', () => {
  const generatedOnly = { items: [{ name: 'DB_PASSWORD', generate: { length: 40 } }] }
  it('is false when there is nothing to ask: no settings, generated-only items, or an empty list', () => {
    expect(hasInstallQuestions(undefined)).toBe(false)
    expect(hasInstallQuestions(generatedOnly)).toBe(false)
    expect(hasInstallQuestions({})).toBe(false)
  })
  it('is true when a question exists (even next to generated ones) or custom vars are offered', () => {
    expect(hasInstallQuestions({ items: [generatedOnly.items[0], { name: 'TOKEN', required: true }] })).toBe(true)
    expect(hasInstallQuestions({ allowCustom: true, ...generatedOnly })).toBe(true)
  })
})

describe('InstallDialog', () => {
  it('lists required questions first and marks optional ones', async () => {
    mockApi()
    renderDialog()
    await screen.findByLabelText('Access token')
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Install Renovate')).toBeInTheDocument()
    const labels = Array.from(dialog.querySelectorAll('form label')).map((l) => l.textContent)
    expect(labels).toEqual(['Access token', 'Log format (optional)', 'Dry run'])
  })

  it('masks sensitive answers until "Show value" is pressed', async () => {
    mockApi()
    renderDialog()
    const token = await screen.findByLabelText('Access token')
    expect(token).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: 'Show value' }))
    expect(token).toHaveAttribute('type', 'text')
  })

  it('renders fixed choices as a dropdown with the default selected', async () => {
    mockApi()
    renderDialog()
    const select = (await screen.findByLabelText(/Log format/)) as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(select.value).toBe('json')
    // Optional, so "Not set" stays available even with a default.
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'json', 'pretty'])
  })

  it('offers no empty choice for a required dropdown that has a default', async () => {
    mockApi()
    renderDialog({
      ...app,
      settings: { items: [{ name: 'LOG_FORMAT', options: ['json', 'pretty'], default: 'json', required: true }] },
    })
    const select = (await screen.findByLabelText(/Log format/)) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['json', 'pretty'])
  })

  it('sends a cleared optional answer as empty, so its default is not put back', async () => {
    const fetchSpy = mockApi()
    renderDialog({ ...app, settings: { items: [{ name: 'HTTP_PROXY', default: 'http://proxy:3128' }] } })

    const field = await screen.findByLabelText(/Http proxy/)
    expect(field).toHaveValue('http://proxy:3128')
    await userEvent.clear(field)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(submits(fetchSpy)).toHaveLength(1))
    expect(sentBody(fetchSpy)).toEqual({ settings: { HTTP_PROXY: '' } })
  })

  it('treats a YAML null default as no default, never showing "null"', async () => {
    mockApi()
    renderDialog({ ...app, settings: { items: [{ name: 'EXTRA', default: null }] } })
    expect(await screen.findByLabelText(/Extra/)).toHaveValue('')
  })

  it('submits answers: defaults kept, booleans as text, then closes', async () => {
    const fetchSpy = mockApi()
    renderDialog()

    await userEvent.type(await screen.findByLabelText('Access token'), 's3cr3t')
    await userEvent.click(screen.getByRole('switch', { name: 'Dry run' }))
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(submits(fetchSpy)).toHaveLength(1))
    expect(sentBody(fetchSpy)).toEqual({
      settings: { LOG_FORMAT: 'json', RENOVATE_TOKEN: 's3cr3t', DRY_RUN: 'true' },
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('sends custom variables, dropping blank rows; the section starts collapsed', async () => {
    const fetchSpy = mockApi()
    renderDialog()
    await screen.findByLabelText('Access token')
    const details = screen.getByText('Custom environment variables').closest('details')
    expect(details).not.toHaveAttribute('open')

    await userEvent.click(screen.getByRole('button', { name: 'Add variable' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add variable' }))
    await userEvent.type(screen.getAllByLabelText('Variable name')[0], 'HTTP_PROXY')
    await userEvent.type(screen.getAllByLabelText('Variable value')[0], 'http://p:3128')
    await userEvent.type(screen.getByLabelText('Access token'), 't')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(submits(fetchSpy)).toHaveLength(1))
    expect(sentBody(fetchSpy).custom).toEqual([{ name: 'HTTP_PROXY', value: 'http://p:3128' }])
    // An untouched switch still answers: YAML `default: false` is sent as "false".
    expect(sentBody(fetchSpy).settings.DRY_RUN).toBe('false')
  })

  it('hides machine-generated items: the server makes those secrets, the dialog never asks', async () => {
    mockApi()
    renderDialog({
      ...app,
      settings: {
        items: [
          { name: 'DB_PASSWORD', generate: { length: 40 } },
          { name: 'TOKEN', required: true, sensitive: true },
        ],
      },
    })
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByLabelText('Token')).toBeInTheDocument()
    // Regex, not the exact string: an unrequired question's label carries an " (optional)" suffix.
    expect(within(dialog).queryByLabelText(/Db password/)).toBeNull()
  })

  it('hides custom variables when the app does not allow them', async () => {
    mockApi()
    renderDialog({ ...app, settings: { ...app.settings, allowCustom: false } })
    await screen.findByLabelText('Access token')
    expect(screen.queryByText('Custom environment variables')).not.toBeInTheDocument()
  })

  it('shows server field errors under their fields and keeps everything typed', async () => {
    mockApi({
      submit: reply(
        {
          message: 'Some settings need attention',
          errors: [
            { name: 'RENOVATE_TOKEN', message: 'Required' },
            { name: 'custom.0', message: 'Duplicate name' },
          ],
        },
        400,
      ),
    })
    renderDialog()
    await screen.findByLabelText('Access token')

    await userEvent.click(screen.getByRole('button', { name: 'Add variable' }))
    await userEvent.type(screen.getByLabelText('Variable name'), 'X')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(await screen.findByText('Required')).toBeInTheDocument()
    expect(screen.getByText('Duplicate name')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Some settings need attention')
    expect(screen.getByLabelText('Variable name')).toHaveValue('X')
    expect(screen.getByText('Custom environment variables').closest('details')).toHaveAttribute('open')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('shows errors that belong to no field (whole request, unknown names) in the alert', async () => {
    mockApi({
      submit: reply(
        {
          message: 'Some settings need attention',
          errors: [
            { name: 'settings', message: 'All settings together are too large (max 64 KiB)' },
            { name: 'NEW_QUESTION', message: 'Required' },
          ],
        },
        400,
      ),
    })
    renderDialog()

    await userEvent.type(await screen.findByLabelText('Access token'), 't')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Some settings need attention')
    expect(alert).toHaveTextContent('All settings together are too large (max 64 KiB)')
    expect(alert).toHaveTextContent('NEW_QUESTION: Required')
  })

  it('shows an unavailable store inside the dialog, keeping the typed token', async () => {
    mockApi({
      submit: reply({ message: "Couldn't save the settings right now. Try again in a minute.", statusCode: 503 }, 503),
    })
    renderDialog()

    await userEvent.type(await screen.findByLabelText('Access token'), 's3cr3t')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the settings right now")
    expect(screen.getByLabelText('Access token')).toHaveValue('s3cr3t')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('disables Install and Cancel while the request is in flight', async () => {
    mockApi({ submit: new Promise<Response>(() => {}) })
    renderDialog()

    await userEvent.type(await screen.findByLabelText('Access token'), 't')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(await screen.findByRole('button', { name: 'Installing...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('prefills answers and custom variables from the stored settings (a reinstall keeps them)', async () => {
    mockApi({
      stored: {
        settings: { RENOVATE_TOKEN: 'old', LOG_FORMAT: 'pretty' },
        custom: [{ name: 'HTTP_PROXY', value: 'http://p' }],
      },
    })
    renderDialog()

    expect(await screen.findByLabelText('Access token')).toHaveValue('old')
    expect((screen.getByLabelText(/Log format/) as HTMLSelectElement).value).toBe('pretty')
    expect(screen.getByText('Custom environment variables').closest('details')).toHaveAttribute('open')
    expect(screen.getByLabelText('Variable name')).toHaveValue('HTTP_PROXY')
  })

  it("shows a question's default when the stored entry has no answer for it", async () => {
    mockApi()
    renderDialog()
    await screen.findByLabelText('Access token')
    expect((screen.getByLabelText(/Log format/) as HTMLSelectElement).value).toBe('json')
  })

  it('shows an error and no form when the stored settings cannot be loaded', async () => {
    const fetchSpy = mockApi({ storedStatus: 503 })
    renderDialog()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't load the current settings. Try again in a minute.",
    )
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument()
    expect(submits(fetchSpy)).toHaveLength(0)
  })

  it('edit mode: titled "Renovate settings", saves with PUT, toasts and closes', async () => {
    const fetchSpy = mockApi({ stored: { settings: { RENOVATE_TOKEN: 'old' }, custom: [] } })
    renderDialog(app, 'edit')

    await screen.findByLabelText('Access token')
    expect(screen.getByRole('heading', { name: 'Renovate settings' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(submits(fetchSpy)).toHaveLength(1))
    const [url, init] = submits(fetchSpy)[0] as [string, RequestInit]
    expect(url).toBe('/api/apps/renovate/settings')
    expect(init.method).toBe('PUT')
    expect(sentBody(fetchSpy)).toEqual({ settings: { LOG_FORMAT: 'json', RENOVATE_TOKEN: 'old', DRY_RUN: 'false' } })
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Settings saved', {
        description: 'Renovate will restart in a moment to use them.',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('Cancel discards edits: reopening starts from the stored settings again', async () => {
    mockApi({ stored: { settings: { RENOVATE_TOKEN: 'old' }, custom: [] } })
    renderDialog()
    const token = await screen.findByLabelText('Access token')
    await userEvent.clear(token)
    await userEvent.type(token, 'abc')

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'reopen' }))

    expect(await screen.findByLabelText('Access token')).toHaveValue('old')
  })
})
