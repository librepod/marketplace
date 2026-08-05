import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PlatformPanel } from './PlatformPanel'
import type { CatalogApp } from '@librepod/shared'

const systemApp: CatalogApp = {
  name: 'frp-operator',
  displayName: 'FRP Operator',
  description: 'FRP operator',
  category: 'Network',
  version: 'v0.9.0',
  icon: 'https://example.com/frp.png',
  sourceType: 'oci-kustomize',
  sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/frp-operator',
  system: true,
  installedStatus: 'running',
}

function withProviders(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('PlatformPanel', () => {
  it('renders system apps as read-only rows with a System tag and status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [systemApp],
    } as Response)

    render(withProviders(<PlatformPanel />))

    await waitFor(() => {
      expect(screen.getByText('FRP Operator')).toBeInTheDocument()
    })
    expect(screen.getByText('System')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    // No install affordance on a platform component
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument()
  })

  it('renders nothing for the list when no system apps are returned', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response)

    const { container } = render(withProviders(<PlatformPanel />))

    await waitFor(() => {
      expect(screen.getByText(/Platform/)).toBeInTheDocument()
    })
    expect(container.querySelector('ul')).toBeNull()
  })
})
