import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CatalogPage } from './CatalogPage'
import type { CatalogApp } from '@librepod/shared'

const mockApps: CatalogApp[] = [
  {
    name: 'vaultwarden',
    displayName: 'Vaultwarden',
    description: 'Password manager',
    category: 'Security',
    version: '1.32.7',
    icon: 'https://example.com/vaultwarden.png',
    sourceType: 'oci-kustomize',
    sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/vaultwarden',
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

describe('CatalogPage', () => {
  it('shows exactly 12 skeleton cards while loading (STAT-02, D-10)', () => {
    // Hang fetch indefinitely so isPending stays true
    vi.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}))
    render(<CatalogPage />, { wrapper: createWrapper() })
    // Skeleton cards have the border/bg-card shape but no text content
    // Count by checking the container children count
    const skeletons = document.querySelectorAll('[data-testid="app-card-skeleton"]')
    expect(skeletons).toHaveLength(12)
  })

  it('renders app cards after data loads (CAT-01)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockApps,
    } as Response)
    render(<CatalogPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Vaultwarden')).toBeInTheDocument()
    })
  })

  it('shows error block on fetch failure (D-11)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response)
    render(<CatalogPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Failed to load apps')).toBeInTheDocument()
    })
  })

  it('shows empty state when API returns empty array', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as Response)
    render(<CatalogPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('No apps available')).toBeInTheDocument()
    })
  })

  it('renders page title "App Catalog" per UI-SPEC copywriting', () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}))
    render(<CatalogPage />, { wrapper: createWrapper() })
    expect(screen.getByText('App Catalog')).toBeInTheDocument()
  })
})
