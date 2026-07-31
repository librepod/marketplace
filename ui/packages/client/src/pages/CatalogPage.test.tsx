import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

// Multi-app, multi-category fixture for filter tests (2 Network, 1 Security).
const mockAppsMany: CatalogApp[] = [
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
  {
    name: 'wg-easy',
    displayName: 'WG Easy',
    description: 'WireGuard VPN',
    category: 'Network',
    version: '1.0.0',
    icon: 'https://example.com/wg-easy.png',
    sourceType: 'oci-kustomize',
    sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/wg-easy',
  },
  {
    name: 'adguard',
    displayName: 'AdGuard Home',
    description: 'Network-wide DNS ad blocker',
    category: 'Network',
    version: '0.107.0',
    icon: 'https://example.com/adguard.png',
    sourceType: 'oci-kustomize',
    sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/adguard',
  },
]

function mockAppsResponse(apps: CatalogApp[]) {
  return { ok: true, json: async () => apps } as Response
}

function createWrapper(initialEntries?: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
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
    const skeletons = document.querySelectorAll('[data-testid="app-card-skeleton"]')
    expect(skeletons).toHaveLength(12)
  })

  it('renders app cards after data loads (CAT-01)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockAppsResponse(mockApps))
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
      expect(screen.getByRole('heading', { name: "Couldn't reach your device" })).toBeInTheDocument()
    })
  })

  it('shows empty state when API returns empty array', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockAppsResponse([]))
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

  it('filters cards by category when a chip is selected', async () => {
    const user = userEvent.setup()
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockAppsResponse(mockAppsMany))
    render(<CatalogPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Vaultwarden')).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: 'Network' }))
    expect(screen.queryByText('Vaultwarden')).not.toBeInTheDocument()
    expect(screen.getByText('WG Easy')).toBeInTheDocument()
    expect(screen.getByText('AdGuard Home')).toBeInTheDocument()
  })

  it('filters cards by search text (name + description)', async () => {
    const user = userEvent.setup()
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockAppsResponse(mockAppsMany))
    render(<CatalogPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Vaultwarden')).toBeInTheDocument()
    })
    await user.type(screen.getByRole('textbox', { name: 'Search apps' }), 'dns')
    expect(screen.getByText('AdGuard Home')).toBeInTheDocument()
    expect(screen.queryByText('Vaultwarden')).not.toBeInTheDocument()
    expect(screen.queryByText('WG Easy')).not.toBeInTheDocument()
  })

  it('combines category and search filters (AND)', async () => {
    const user = userEvent.setup()
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockAppsResponse(mockAppsMany))
    render(<CatalogPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Vaultwarden')).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: 'Network' }))
    await user.type(screen.getByRole('textbox', { name: 'Search apps' }), 'dns')
    expect(screen.getByText('AdGuard Home')).toBeInTheDocument()
    expect(screen.queryByText('WG Easy')).not.toBeInTheDocument()
  })

  it('shows the no-matches state and clears filters', async () => {
    const user = userEvent.setup()
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockAppsResponse(mockAppsMany))
    render(<CatalogPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Vaultwarden')).toBeInTheDocument()
    })
    await user.type(screen.getByRole('textbox', { name: 'Search apps' }), 'xyznomatch')
    expect(await screen.findByText('No apps found')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByText('Vaultwarden')).toBeInTheDocument()
  })

  it('applies a category filter from the URL on load (shareable link)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockAppsResponse(mockAppsMany))
    render(<CatalogPage />, { wrapper: createWrapper(['/?category=Network']) })
    await waitFor(() => {
      expect(screen.getByText('WG Easy')).toBeInTheDocument()
    })
    expect(screen.queryByText('Vaultwarden')).not.toBeInTheDocument()
  })
})
