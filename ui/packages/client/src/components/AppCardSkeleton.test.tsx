import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AppCardSkeleton } from './AppCardSkeleton'

describe('AppCardSkeleton', () => {
  it('renders without crashing', () => {
    const { container } = render(<AppCardSkeleton />)
    expect(container.firstChild).toBeInTheDocument()
  })

  it('has fixed height matching real card (200px per UI-SPEC)', () => {
    const { container } = render(<AppCardSkeleton />)
    const card = container.firstChild as HTMLElement
    expect(card.style.height).toBe('200px')
  })
})
