import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MyAppsPage } from './MyAppsPage'
import type { CatalogApp } from '@librepod/shared'

const mockInstalledApps: CatalogApp[] = [
  {
    name: 'vaultwarden',
    displayName: 'Vaultwarden',
    description: 'Password manager',
    category: 'Security',
    version: '1.32.7',
    icon: 'https://example.com/vaultwarden.png',
    sourceType: 'oci-kustomize',
    sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/vaultwarden',
    installedStatus: 'running',
  },
]

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('MyAppsPage (INST-03)', () => {
  it('shows loading state while fetching installed apps', () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}))
    render(<MyAppsPage />, { wrapper: createWrapper() })
    // Loading state renders skeleton cards (same skeleton pattern as CatalogPage)
    const skeletons = document.querySelectorAll('[data-testid="app-card-skeleton"]')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('renders installed app cards after data loads (INST-03)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockInstalledApps,
    } as Response)
    render(<MyAppsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Vaultwarden')).toBeInTheDocument()
    })
  })

  it('shows error block on fetch failure', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response)
    render(<MyAppsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText(/failed to/i)).toBeInTheDocument()
    })
  })

  it('shows empty state when no apps installed (INST-03)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response)
    render(<MyAppsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      // Empty state message — MyAppsPage uses different copy from CatalogPage
      expect(screen.getByText(/no apps installed/i)).toBeInTheDocument()
    })
  })

  it('fetches from /api/installed endpoint (INST-03)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response)
    render(<MyAppsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/installed')
    })
  })

  it('installed app cards show StatusBadge when installedStatus is running (STAT-01)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockInstalledApps,
    } as Response)
    render(<MyAppsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Vaultwarden')).toBeInTheDocument()
    })
    // StatusBadge renders 'Running' label for running apps (STAT-01, D-13)
    expect(screen.getByText('Running')).toBeInTheDocument()
  })
})
