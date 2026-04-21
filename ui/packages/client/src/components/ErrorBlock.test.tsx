import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBlock } from './ErrorBlock'

describe('ErrorBlock', () => {
  it('renders error heading per UI-SPEC copywriting contract', () => {
    render(<ErrorBlock onRetry={() => {}} />)
    expect(screen.getByText('Failed to load apps')).toBeInTheDocument()
  })

  it('renders error body per UI-SPEC copywriting contract', () => {
    render(<ErrorBlock onRetry={() => {}} />)
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument()
  })

  it('renders Retry Loading button per UI-SPEC', () => {
    render(<ErrorBlock onRetry={() => {}} />)
    expect(screen.getByRole('button', { name: 'Retry Loading' })).toBeInTheDocument()
  })

  it('calls onRetry when Retry Loading button is clicked', async () => {
    const onRetry = vi.fn()
    render(<ErrorBlock onRetry={onRetry} />)
    await userEvent.click(screen.getByRole('button', { name: 'Retry Loading' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
