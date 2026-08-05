import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NotFoundPage } from './NotFoundPage'

describe('NotFoundPage', () => {
  it('renders a page-not-found heading', () => {
    render(<MemoryRouter><NotFoundPage /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })

  it('offers a link home (back to your apps)', () => {
    render(<MemoryRouter><NotFoundPage /></MemoryRouter>)
    const link = screen.getByRole('link', { name: /back to your apps/i })
    expect(link).toHaveAttribute('href', '/')
  })
})
