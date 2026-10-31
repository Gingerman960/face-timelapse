// Critique round 5, P2-11: the pen ticked on a fixed 280 ms timer, often onto unexposed prints,
// the copy came before the pictures, and a long background encode played its moment unseen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { inked, nextSavedStep, printExposed, savedTiming, told, useSavedSequence, type SavedStage } from './useSavedSequence'

const TOKENS = { developMs: 700, penMs: 360, xfadeMs: 120 }

describe('the saved sequence, step by step', () => {
  const t = savedTiming(TOKENS, false)

  it('times the moment from the develop and the pen: the second print 240 ms on, the pen at 60 % of its develop', () => {
    expect(t).toEqual({ startMs: 120, staggerMs: 240, inkMs: 420, penMs: 360, capMs: 2000 })
  })

  it('waits until the window is seen, then lets the phase cross-fade land first', () => {
    expect(nextSavedStep('waiting', [true, true], false, t)).toBeNull()
    expect(nextSavedStep('waiting', [true, true], true, t)).toEqual({ stage: 'latent', afterMs: 120 })
  })

  it('develops the first print once its image is in, the second 240 ms later once its image is in', () => {
    expect(nextSavedStep('latent', [false, true], true, t)).toBeNull()
    expect(nextSavedStep('latent', [true, false], true, t)).toEqual({ stage: 'first', afterMs: 0 })
    expect(nextSavedStep('first', [true, false], true, t)).toBeNull()
    expect(nextSavedStep('first', [true, true], true, t)).toEqual({ stage: 'both', afterMs: 240 })
  })

  it('the pen writes at 60 % of the second print’s develop, and the facts come as it lifts', () => {
    expect(nextSavedStep('both', [true, true], true, t)).toEqual({ stage: 'inked', afterMs: 420 })
    expect(nextSavedStep('inked', [true, true], true, t)).toEqual({ stage: 'told', afterMs: 360 })
    expect(nextSavedStep('told', [true, true], true, t)).toBeNull()
  })

  it('under reduced motion nothing staggers: the tick fades in at once and the facts follow its fade', () => {
    expect(savedTiming({ developMs: 0, penMs: 360, xfadeMs: 120 }, true)).toEqual({ startMs: 0, staggerMs: 0, inkMs: 0, penMs: 120, capMs: 2000 })
  })

  it('names what each stage shows', () => {
    const stages: SavedStage[] = ['waiting', 'latent', 'first', 'both', 'inked', 'told']
    expect(stages.map((s) => [printExposed(s, 0), printExposed(s, 1), inked(s), told(s)])).toEqual([
      [false, false, false, false],
      [false, false, false, false],
      [true, false, false, false],
      [true, true, false, false],
      [true, true, true, false],
      [true, true, true, true],
    ])
  })
})

describe('useSavedSequence', () => {
  let visibility: DocumentVisibilityState
  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(document, 'visibilityState')
  })

  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))
  type Loaded = readonly [boolean, boolean]
  const mount = (loaded: Loaded = [false, false], enabled = true) =>
    renderHook(({ l }: { l: Loaded }) => useSavedSequence(l, enabled), { initialProps: { l: loaded } })

  it('develops print, print, then the pen, then the facts, never ahead of the images', () => {
    // Arrange
    const { result, rerender } = mount()

    // Act + Assert: the phase's cross-fade lands, and the film waits for its images.
    expect(result.current).toBe('waiting')
    advance(120)
    expect(result.current).toBe('latent')
    advance(1000)
    expect(result.current).toBe('latent')
    rerender({ l: [true, false] })
    advance(0)
    expect(result.current).toBe('first')
    // The second image is late: its print develops when it lands, not before.
    advance(600)
    expect(result.current).toBe('first')
    rerender({ l: [true, true] })
    advance(0)
    expect(result.current).toBe('both')
    advance(419)
    expect(result.current).toBe('both')
    advance(1)
    expect(result.current).toBe('inked')
    advance(359)
    expect(result.current).toBe('inked')
    advance(1)
    expect(result.current).toBe('told')
  })

  it('the second print follows the first by 240 ms when both images are already in', () => {
    const { result } = mount([true, true])
    advance(120)
    advance(0)
    expect(result.current).toBe('first')
    advance(239)
    expect(result.current).toBe('first')
    advance(1)
    expect(result.current).toBe('both')
  })

  it('a window hidden when Saved arrived plays the moment when it is shown again', () => {
    // Arrange: a long encode finished in the background.
    visibility = 'hidden'
    const { result } = mount([true, true])

    // Act
    advance(60_000)

    // Assert
    expect(result.current).toBe('waiting')

    // Act
    visibility = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    advance(0)

    // Assert
    expect(result.current).toBe('latent')
  })

  it('a window in the background plays the moment when it gets focus', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
    const { result } = mount([true, true])
    advance(10_000)
    expect(result.current).toBe('waiting')

    vi.mocked(document.hasFocus).mockReturnValue(true)
    act(() => window.dispatchEvent(new Event('focus')))
    advance(0)
    expect(result.current).toBe('latent')
  })

  it('images that never arrive hold the moment for 2 s at most, so the facts still come', () => {
    const { result } = mount()
    advance(120)
    advance(1999)
    expect(result.current).toBe('latent')
    advance(1)
    advance(0)
    expect(result.current).toBe('first')
    advance(240)
    expect(result.current).toBe('both')
    advance(420)
    expect(result.current).toBe('inked')
    advance(360)
    expect(result.current).toBe('told')
  })

  it('without prints there is nothing to wait for: the facts are there at once', () => {
    const { result } = mount([false, false], false)
    expect(result.current).toBe('told')
  })
})
