import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CatalogApp } from '@librepod/shared'
import { toast } from 'sonner'
import { useInstallApp } from '@/hooks/useInstallApp'
import { InstallDialog, humanize } from './InstallDialog'

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

function Harness({ app: subject }: { app: CatalogApp }) {
  const mutation = useInstallApp(subject.name, subject.displayName)
  const [open, setOpen] = useState(true)
  return (
    <>
      <button onClick={() => setOpen(true)}>reopen</button>
      <InstallDialog app={subject} open={open} onOpenChange={setOpen} installMutation={mutation} />
    </>
  )
}

function renderDialog(subject: CatalogApp = app) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <Harness app={subject} />
    </QueryClientProvider>,
  )
}

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response
const sentBody = (spy: { mock: { calls: unknown[][] } }) =>
  JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)

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

describe('InstallDialog', () => {
  it('lists required questions first and marks optional ones', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Install Renovate')).toBeInTheDocument()
    const labels = Array.from(dialog.querySelectorAll('form label')).map((l) => l.textContent)
    expect(labels).toEqual(['Access token', 'Log format (optional)', 'Dry run'])
  })

  it('masks sensitive answers until "Show value" is pressed', async () => {
    renderDialog()
    const token = screen.getByLabelText('Access token')
    expect(token).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: 'Show value' }))
    expect(token).toHaveAttribute('type', 'text')
  })

  it('renders fixed choices as a dropdown with the default selected', () => {
    renderDialog()
    const select = screen.getByLabelText(/Log format/) as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(select.value).toBe('json')
    // Optional, so "Not set" stays available even with a default.
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'json', 'pretty'])
  })

  it('offers no empty choice for a required dropdown that has a default', () => {
    renderDialog({
      ...app,
      settings: { items: [{ name: 'LOG_FORMAT', options: ['json', 'pretty'], default: 'json', required: true }] },
    })
    const select = screen.getByLabelText(/Log format/) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['json', 'pretty'])
  })

  it('sends a cleared optional answer as empty, so its default is not put back', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ success: true, message: 'ok' }))
    renderDialog({ ...app, settings: { items: [{ name: 'HTTP_PROXY', default: 'http://proxy:3128' }] } })

    const field = screen.getByLabelText(/Http proxy/)
    expect(field).toHaveValue('http://proxy:3128')
    await userEvent.clear(field)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(sentBody(fetchSpy)).toEqual({ settings: { HTTP_PROXY: '' } })
  })

  it('treats a YAML null default as no default, never showing "null"', () => {
    renderDialog({ ...app, settings: { items: [{ name: 'EXTRA', default: null }] } })
    expect(screen.getByLabelText(/Extra/)).toHaveValue('')
  })

  it('submits answers: defaults kept, booleans as text, then closes', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ success: true, message: 'ok' }))
    renderDialog()

    await userEvent.type(screen.getByLabelText('Access token'), 's3cr3t')
    await userEvent.click(screen.getByRole('switch', { name: 'Dry run' }))
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(sentBody(fetchSpy)).toEqual({
      settings: { LOG_FORMAT: 'json', RENOVATE_TOKEN: 's3cr3t', DRY_RUN: 'true' },
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('sends custom variables, dropping blank rows; the section starts collapsed', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ success: true, message: 'ok' }))
    renderDialog()
    const details = screen.getByText('Custom environment variables').closest('details')
    expect(details).not.toHaveAttribute('open')

    await userEvent.click(screen.getByRole('button', { name: 'Add variable' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add variable' }))
    await userEvent.type(screen.getAllByLabelText('Variable name')[0], 'HTTP_PROXY')
    await userEvent.type(screen.getAllByLabelText('Variable value')[0], 'http://p:3128')
    await userEvent.type(screen.getByLabelText('Access token'), 't')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(sentBody(fetchSpy).custom).toEqual([{ name: 'HTTP_PROXY', value: 'http://p:3128' }])
    // An untouched switch still answers: YAML `default: false` is sent as "false".
    expect(sentBody(fetchSpy).settings.DRY_RUN).toBe('false')
  })

  it('hides custom variables when the app does not allow them', () => {
    renderDialog({ ...app, settings: { ...app.settings, allowCustom: false } })
    expect(screen.queryByText('Custom environment variables')).not.toBeInTheDocument()
  })

  it('shows server field errors under their fields and keeps everything typed', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      reply(
        {
          message: 'Some settings need attention',
          errors: [
            { name: 'RENOVATE_TOKEN', message: 'Required' },
            { name: 'custom.0', message: 'Duplicate name' },
          ],
        },
        400,
      ),
    )
    renderDialog()

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
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      reply(
        {
          message: 'Some settings need attention',
          errors: [
            { name: 'settings', message: 'All settings together are too large (max 64 KiB)' },
            { name: 'NEW_QUESTION', message: 'Required' },
          ],
        },
        400,
      ),
    )
    renderDialog()

    await userEvent.type(screen.getByLabelText('Access token'), 't')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Some settings need attention')
    expect(alert).toHaveTextContent('All settings together are too large (max 64 KiB)')
    expect(alert).toHaveTextContent('NEW_QUESTION: Required')
  })

  it('shows an unavailable store inside the dialog, keeping the typed token', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      reply({ message: "Couldn't save the settings right now. Try again in a minute.", statusCode: 503 }, 503),
    )
    renderDialog()

    await userEvent.type(screen.getByLabelText('Access token'), 's3cr3t')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the settings right now")
    expect(screen.getByLabelText('Access token')).toHaveValue('s3cr3t')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('disables Install and Cancel while the request is in flight', async () => {
    vi.spyOn(global, 'fetch').mockReturnValueOnce(new Promise<Response>(() => {}))
    renderDialog()

    await userEvent.type(screen.getByLabelText('Access token'), 't')
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(await screen.findByRole('button', { name: 'Installing...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('Cancel closes the dialog and reopening starts from the defaults', async () => {
    renderDialog()
    await userEvent.type(screen.getByLabelText('Access token'), 'abc')

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'reopen' }))

    expect(await screen.findByLabelText('Access token')).toHaveValue('')
  })
})
