import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppCard } from './AppCard'
import type { CatalogApp } from '@librepod/shared'

const mockApp: CatalogApp = {
  name: 'vaultwarden',
  displayName: 'Vaultwarden',
  description: 'A password manager compatible with Bitwarden clients',
  category: 'Security',
  version: '1.32.7',
  icon: 'https://example.com/vaultwarden.png',
  sourceType: 'oci-kustomize',
  sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/vaultwarden',
}

describe('AppCard', () => {
  it('renders app display name', () => {
    render(<MemoryRouter><AppCard app={mockApp} /></MemoryRouter>)
    expect(screen.getByText('Vaultwarden')).toBeInTheDocument()
  })

  it('renders truncated description', () => {
    render(<MemoryRouter><AppCard app={mockApp} /></MemoryRouter>)
    expect(screen.getByText('A password manager compatible with Bitwarden clients')).toBeInTheDocument()
  })

  it('renders category badge (CAT-03)', () => {
    render(<MemoryRouter><AppCard app={mockApp} /></MemoryRouter>)
    expect(screen.getByText('Security')).toBeInTheDocument()
  })

  it('renders icon img element', () => {
    render(<MemoryRouter><AppCard app={mockApp} /></MemoryRouter>)
    const img = screen.getByRole('img', { name: 'Vaultwarden' })
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', 'https://example.com/vaultwarden.png')
  })

  it('does NOT show version on card (version deferred to detail page per D-04)', () => {
    render(<MemoryRouter><AppCard app={mockApp} /></MemoryRouter>)
    expect(screen.queryByText('1.32.7')).not.toBeInTheDocument()
  })
})
