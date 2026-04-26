import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppDetailPage } from './AppDetailPage'
import type { CatalogApp } from '@librepod/shared'

const mockApp: CatalogApp = {
  name: 'vaultwarden',
  displayName: 'Vaultwarden',
  description: 'A password manager compatible with all Bitwarden clients',
  category: 'Security',
  version: '1.32.7',
  icon: 'https://example.com/vaultwarden.png',
  sourceType: 'oci-kustomize',
  sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/vaultwarden',
}

function createWrapper(appName = 'vaultwarden') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/apps/${appName}`]}>
        <Routes>
          <Route path="/apps/:name" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('AppDetailPage', () => {
  it('renders app name, version, category, and description (CAT-02)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockApp,
    } as Response)
    render(<AppDetailPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Vaultwarden')).toBeInTheDocument()
    })
    expect(screen.getByText('1.32.7')).toBeInTheDocument()
    expect(screen.getByText('Security')).toBeInTheDocument()
    expect(screen.getByText('A password manager compatible with all Bitwarden clients')).toBeInTheDocument()
  })

  it('renders "← Back to catalog" navigation link (D-09)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockApp,
    } as Response)
    render(<AppDetailPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('← Back to catalog')).toBeInTheDocument()
    })
  })

  it('renders disabled Install App button placeholder (D-08)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockApp,
    } as Response)
    render(<AppDetailPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Install App' })
      expect(btn).toBeInTheDocument()
      expect(btn).toBeDisabled()
    })
  })

  it('renders "View source" link pointing to sourceUrl (D-08)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockApp,
    } as Response)
    render(<AppDetailPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      const link = screen.getByRole('link', { name: 'View source' })
      expect(link).toHaveAttribute('href', mockApp.sourceUrl)
    })
  })

  it('shows "App not found" on 404 response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response)
    render(<AppDetailPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('App not found')).toBeInTheDocument()
    })
  })

  describe('install/uninstall actions', () => {
    it('shows enabled Install App button when app is not_installed (INST-01, D-07)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...mockApp, installedStatus: 'not_installed' }),
      } as Response)
      render(<AppDetailPage />, { wrapper: createWrapper() })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Install App' })).toBeInTheDocument()
      })
      const btn = screen.getByRole('button', { name: 'Install App' })
      expect(btn).not.toBeDisabled()
    })

    it('shows Uninstall App button when app is running (INST-02, D-07)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...mockApp, installedStatus: 'running' }),
      } as Response)
      render(<AppDetailPage />, { wrapper: createWrapper() })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Uninstall App' })).toBeInTheDocument()
      })
    })

    it('shows disabled Installing... button when app is installing (D-07)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...mockApp, installedStatus: 'installing' }),
      } as Response)
      render(<AppDetailPage />, { wrapper: createWrapper() })
      await waitFor(() => {
        expect(screen.getByText('Installing...')).toBeInTheDocument()
      })
      const btn = screen.getByText('Installing...').closest('button')!
      expect(btn).toBeDisabled()
    })

    it('shows confirmation dialog when Uninstall App is clicked (INST-02, D-08)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...mockApp, installedStatus: 'running' }),
      } as Response)
      render(<AppDetailPage />, { wrapper: createWrapper() })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Uninstall App' })).toBeInTheDocument()
      })
      screen.getByRole('button', { name: 'Uninstall App' }).click()
      await waitFor(() => {
        expect(screen.getByText('Uninstall Vaultwarden?')).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: 'Keep App' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Uninstall' })).toBeInTheDocument()
    })

    it('shows success toast after install (STAT-03, D-11)', async () => {
      // Mock app data fetch (not_installed)
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ ...mockApp, installedStatus: 'not_installed' }),
        } as Response)
        // Mock install POST
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true, message: 'App is being deployed' }),
        } as Response)

      render(<AppDetailPage />, { wrapper: createWrapper() })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Install App' })).toBeInTheDocument()
      })
      screen.getByRole('button', { name: 'Install App' }).click()
      await waitFor(() => {
        expect(screen.getByText(/is being deployed/)).toBeInTheDocument()
      })
    })

    it('shows error toast when install fails (STAT-03, D-12)', async () => {
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ ...mockApp, installedStatus: 'not_installed' }),
        } as Response)
        // Mock install POST failure
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ message: 'Could not reach the app repository' }),
        } as Response)

      render(<AppDetailPage />, { wrapper: createWrapper() })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Install App' })).toBeInTheDocument()
      })
      screen.getByRole('button', { name: 'Install App' }).click()
      await waitFor(() => {
        expect(screen.getByText(/Could not reach the app repository/)).toBeInTheDocument()
      })
    })
  })
})
