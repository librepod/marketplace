import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBlock } from './ErrorBlock'

describe('ErrorBlock', () => {
  it('renders error heading per UI-SPEC copywriting contract', () => {
    render(<ErrorBlock onRetry={() => {}} />)
    expect(screen.getByRole('heading', { name: "Couldn't reach your device" })).toBeInTheDocument()
  })

  it('renders error body per UI-SPEC copywriting contract', () => {
    render(<ErrorBlock onRetry={() => {}} />)
    expect(screen.getByText(/we couldn't reach your device to load this/i)).toBeInTheDocument()
  })

  it('renders Try again button per UI-SPEC', () => {
    render(<ErrorBlock onRetry={() => {}} />)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('calls onRetry when Try again button is clicked', async () => {
    const onRetry = vi.fn()
    render(<ErrorBlock onRetry={onRetry} />)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
