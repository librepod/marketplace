import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LaunchTile } from './LaunchTile'
import type { CatalogApp } from '@librepod/shared'

const baseApp: CatalogApp = {
  name: 'vaultwarden',
  displayName: 'Vaultwarden',
  description: 'A password manager',
  category: 'Security',
  version: '1.32.7',
  icon: 'https://example.com/vaultwarden.png',
  sourceType: 'oci-kustomize',
  sourceUrl: 'oci://ghcr.io/librepod/marketplace/apps/vaultwarden',
  installedStatus: 'running',
}

function renderTile(app: CatalogApp, baseDomain = 'example.com') {
  return render(
    <MemoryRouter>
      <LaunchTile app={app} baseDomain={baseDomain} />
    </MemoryRouter>,
  )
}

describe('LaunchTile', () => {
  it('launches at the computed URL when no override and launchable is unknown', () => {
    renderTile(baseApp)
    const link = screen.getByRole('link', { name: /Open Vaultwarden/ })
    expect(link).toHaveAttribute('href', 'https://vaultwarden.example.com')
  })

  it('prefers launchUrl over the computed URL (Axis A)', () => {
    renderTile({ ...baseApp, launchUrl: 'https://vaultwarden.example.com/ui' })
    const link = screen.getByRole('link', { name: /Open Vaultwarden/ })
    expect(link).toHaveAttribute('href', 'https://vaultwarden.example.com/ui')
  })

  it('when launchable is false, renders NO launch link and routes the body to detail (Axis B / rustdesk)', () => {
    const rustdesk: CatalogApp = {
      ...baseApp,
      name: 'rustdesk-server-oss',
      displayName: 'RustDesk Server',
      launchable: false,
    }
    renderTile(rustdesk)

    // No "Open <app>" launch anchor at all.
    expect(screen.queryByRole('link', { name: /Open RustDesk Server/ })).not.toBeInTheDocument()
    // Body subtitle shows the non-launchable copy.
    expect(screen.getByText('Open details')).toBeInTheDocument()
    // The Manage control (routes to the detail page) is still present.
    expect(screen.getByRole('link', { name: /Manage RustDesk Server/ })).toBeInTheDocument()
    // At least one link targets the detail route (body and/or manage).
    const detailLinks = screen
      .getAllByRole('link')
      .filter((el) => el.getAttribute('href') === '/apps/rustdesk-server-oss')
    expect(detailLinks.length).toBeGreaterThan(0)
  })

  it('still launches when launchable is explicitly true', () => {
    renderTile({ ...baseApp, launchable: true })
    expect(screen.getByRole('link', { name: /Open Vaultwarden/ })).toBeInTheDocument()
  })
})
