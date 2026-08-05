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

// MyAppsPage fetches BOTH /api/installed (the grid) and /api/config (the base
// domain used to build launch URLs). Route the mock by URL so order doesn't
// matter and config always resolves.
function mockFetch(installed: CatalogApp[] | { ok: false; status: number }) {
  return vi.spyOn(global, 'fetch').mockImplementation((input) => {
    const url = String(input)
    if (url.includes('/api/config')) {
      return Promise.resolve({ ok: true, json: async () => ({ baseDomain: 'libre.pod' }) } as Response)
    }
    // The always-mounted PlatformPanel fetches /api/system-apps; return [] so
    // it renders just its summary and doesn't error or add unexpected rows.
    if (url.includes('/api/system-apps')) {
      return Promise.resolve({ ok: true, json: async () => [] } as Response)
    }
    if (url.includes('/api/installed')) {
      if (Array.isArray(installed)) {
        return Promise.resolve({ ok: true, json: async () => installed } as Response)
      }
      return Promise.resolve(installed as Response)
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  })
}

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

  it('renders installed apps as launch tiles after data loads (INST-03)', async () => {
    mockFetch(mockInstalledApps)
    render(<MyAppsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Vaultwarden')).toBeInTheDocument()
    })
  })

  it('a running tile links directly to the live app URL, opening in a new tab', async () => {
    mockFetch(mockInstalledApps)
    render(<MyAppsPage />, { wrapper: createWrapper() })
    const launch = await screen.findByRole('link', { name: /open vaultwarden/i })
    expect(launch).toHaveAttribute('href', 'https://vaultwarden.libre.pod')
    expect(launch).toHaveAttribute('target', '_blank')
    expect(launch).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('every tile exposes a manage link to the app detail page', async () => {
    mockFetch(mockInstalledApps)
    render(<MyAppsPage />, { wrapper: createWrapper() })
    const manage = await screen.findByRole('link', { name: /manage vaultwarden/i })
    expect(manage).toHaveAttribute('href', '/apps/vaultwarden')
  })

  it('shows error block on fetch failure', async () => {
    mockFetch({ ok: false, status: 500 })
    render(<MyAppsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: "Couldn't reach your device" })).toBeInTheDocument()
    })
  })

  it('shows the first-run welcome when no apps installed (INST-03)', async () => {
    mockFetch([])
    render(<MyAppsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /welcome to your librepod/i })).toBeInTheDocument()
    })
    // The first-run CTA points at the catalog.
    expect(screen.getByRole('link', { name: /browse the catalog/i })).toHaveAttribute('href', '/catalog')
  })

  it('fetches from /api/installed endpoint (INST-03)', async () => {
    const fetchSpy = mockFetch([])
    render(<MyAppsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      // apiFetch wraps fetch and always sends credentials: 'include' so the
      // session cookie travels with every request.
      expect(fetchSpy).toHaveBeenCalledWith('/api/installed', {
        credentials: 'include',
      })
    })
  })

  it('the device summary reports a running count and status (STAT-01)', async () => {
    mockFetch(mockInstalledApps)
    render(<MyAppsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Vaultwarden')).toBeInTheDocument()
    })
    // The tile carries a StatusBadge (role=status) reading 'Running' (STAT-01, D-13).
    expect(screen.getByRole('status')).toHaveTextContent(/Running/)
    // The device summary region labels the running count.
    const summary = screen.getByRole('region', { name: /device status/i })
    expect(summary).toHaveTextContent(/Running/)
  })
})
