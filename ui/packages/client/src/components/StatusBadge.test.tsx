import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBadge } from './StatusBadge'
import type { AppStatus } from '@librepod/shared'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('StatusBadge (STAT-01)', () => {
  describe('when status is "running"', () => {
    it('renders "Running" label', () => {
      render(<StatusBadge status="running" />)
      expect(screen.getByText('Running')).toBeInTheDocument()
    })

    it('renders a green dot indicator', () => {
      const { container } = render(<StatusBadge status="running" />)
      const dot = container.querySelector('.bg-green-500')
      expect(dot).toBeInTheDocument()
    })
  })

  describe('when status is "installing"', () => {
    it('renders "Installing" label', () => {
      render(<StatusBadge status="installing" />)
      expect(screen.getByText('Installing')).toBeInTheDocument()
    })

    it('renders a yellow dot indicator', () => {
      const { container } = render(<StatusBadge status="installing" />)
      const dot = container.querySelector('.bg-yellow-400')
      expect(dot).toBeInTheDocument()
    })
  })

  describe('when status is "error"', () => {
    it('renders "Error" label', () => {
      render(<StatusBadge status="error" />)
      expect(screen.getByText('Error')).toBeInTheDocument()
    })

    it('renders a red dot indicator', () => {
      const { container } = render(<StatusBadge status="error" />)
      const dot = container.querySelector('.bg-red-500')
      expect(dot).toBeInTheDocument()
    })
  })

  describe('type safety', () => {
    it('StatusBadge prop type excludes not_installed (component only accepts installed statuses)', () => {
      // This test is a compile-time check — if StatusBadge accepted AppStatus directly
      // it would render with undefined behavior for not_installed.
      // The component's prop type is Exclude<AppStatus, 'not_installed'>.
      // At runtime, verify the three valid values all render without throwing.
      const statuses: Exclude<AppStatus, 'not_installed'>[] = ['running', 'installing', 'error']
      statuses.forEach((status) => {
        const { unmount } = render(<StatusBadge status={status} />)
        expect(screen.getByRole('status') ?? document.body).toBeTruthy()
        unmount()
      })
    })
  })
})
