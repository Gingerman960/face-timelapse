import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProgressAnnouncer } from './ProgressAnnouncer'

function speak(phase: string | null, fraction: number | null, message: string) {
  return <ProgressAnnouncer phase={phase} fraction={fraction} message={message} />
}

describe('ProgressAnnouncer', () => {
  it('speaks at the start, at each 10 % step and at the end, not on every tick', () => {
    // Arrange
    const { rerender } = render(speak('running', 0, 'Scanning. 0 of 3,593 photos read.'))
    const region = screen.getByRole('status')
    expect(region).toHaveTextContent('Scanning. 0 of 3,593 photos read.')

    // Act: ticks inside the same 10 % step stay silent
    rerender(speak('running', 0.03, 'Scanning. 108 of 3,593 photos read.'))
    rerender(speak('running', 0.09, 'Scanning. 323 of 3,593 photos read.'))

    // Assert
    expect(region).toHaveTextContent('Scanning. 0 of 3,593 photos read.')
    rerender(speak('running', 0.1, 'Scanning. 360 of 3,593 photos read.'))
    expect(region).toHaveTextContent('Scanning. 360 of 3,593 photos read.')
    rerender(speak('running', 0.15, 'Scanning. 540 of 3,593 photos read.'))
    expect(region).toHaveTextContent('Scanning. 360 of 3,593 photos read.')
    rerender(speak('done', 1, 'Scan finished.'))
    expect(region).toHaveTextContent('Scan finished.')
  })

  it('is a polite, visually hidden status region and stays empty while idle', () => {
    render(speak(null, null, 'Idle'))
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveClass('visually-hidden')
    expect(region).toBeEmptyDOMElement()
  })
})
