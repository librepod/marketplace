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
})
