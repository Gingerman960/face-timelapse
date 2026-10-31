// Critique round 5, P1-2: the Days ↔ Timelapse morph paired the wrong prints
// (a fixed name, and a face crop at one end, an aligned frame at the other).
// The selected day now carries its own aligned frame, named by its day, so the
// same picture of the same day travels into the player's frame and back.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { FrameSummary } from '../../ipc/contract'
import { vtPrintName } from '../shell/stepTransition'
import { TransitionPrint } from './TransitionPrint'

const hold = vi.hoisted(() => vi.fn())
const capturing = vi.hoisted(() => ({ now: true }))
vi.mock('../shell/stepTransition', async (original) => ({
  ...(await original<typeof import('../shell/stepTransition')>()),
  holdTransition: hold,
  isCapturing: () => capturing.now,
}))

const FRAME = {
  photoId: '0123456789abcdef',
  dayKey: '2014-05-02',
  takenAt: '2014-05-02T08:41:00',
  timeKnown: true,
  version: '5d0c9e8b',
  residualPx: 1.2,
  adjust: { dx: 0, dy: 0, scale: 1, rotation: 0 },
  lookDelta: null,
} as unknown as FrameSummary

afterEach(() => {
  delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode
  hold.mockClear()
  capturing.now = true
})

describe('the transition print', () => {
  it('is the day’s aligned frame, named by its day', () => {
    // Act
    const { container } = render(<TransitionPrint frame={FRAME} base="http://ftimg.localhost/" cellPx={30} />)

    // Assert
    const print = container.querySelector('[data-vt-print]') as HTMLElement
    expect(print).toHaveAttribute('aria-hidden', 'true')
    expect(print.style.getPropertyValue('--vt-print')).toBe('ft-day-2014-05-02')
    expect(print.querySelector('img')?.getAttribute('src')).toMatch(/\/aligned\/0123456789abcdef\?w=\d+&v=5d0c9e8b$/)
  })

  it('holds a running transition until its picture is decoded', async () => {
    // Arrange
    let settle: () => void = () => undefined
    HTMLImageElement.prototype.decode = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)))

    // Act
    render(<TransitionPrint frame={FRAME} base="http://ftimg.localhost/" cellPx={30} />)

    // Assert: the hold settles with the decode.
    const held = hold.mock.calls[0]?.[0] as Promise<unknown>
    let done = false
    void held.then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    settle()
    await held
    expect(done).toBe(true)
  })

  // UI review 6, L1: every Days selection decoded a frame for nothing, and a failed decode surfaced as an unhandled rejection.
  it('decodes nothing outside a transition', () => {
    const decode = vi.fn(() => Promise.resolve())
    HTMLImageElement.prototype.decode = decode
    capturing.now = false
    render(<TransitionPrint frame={FRAME} base="http://ftimg.localhost/" cellPx={30} />)
    expect(decode).not.toHaveBeenCalled()
    expect(hold).not.toHaveBeenCalled()
  })

  it('a picture that fails to decode releases the hold without an unhandled rejection', async () => {
    HTMLImageElement.prototype.decode = vi.fn(() => Promise.reject(new DOMException('decode failed', 'EncodingError')))
    render(<TransitionPrint frame={FRAME} base="http://ftimg.localhost/" cellPx={30} />)
    await expect(hold.mock.calls[0]?.[0]).resolves.toBeUndefined()
  })

  it('holds nothing where images cannot be decoded ahead', () => {
    render(<TransitionPrint frame={FRAME} base="http://ftimg.localhost/" cellPx={30} />)
    expect(hold).not.toHaveBeenCalled()
  })

  it('names days so the player can match them', () => {
    expect(vtPrintName('2014-05-02')).toBe('ft-day-2014-05-02')
  })
})
