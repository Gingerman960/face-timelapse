// Critique round 5, P2-16: the encoding print could swap its source on every progress event.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useStepped } from './useStepped'

describe('useStepped', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))

  it('passes the first value, then steps at most once a second, to the latest value', () => {
    // Arrange
    const { result, rerender } = renderHook(({ v }) => useStepped(v, 1000), { initialProps: { v: 1 } })
    expect(result.current).toBe(1)

    // Act: a burst of progress inside one second.
    rerender({ v: 2 })
    advance(400)
    rerender({ v: 3 })
    advance(400)
    rerender({ v: 4 })

    // Assert: nothing yet; then one step, to the newest value.
    expect(result.current).toBe(1)
    advance(199)
    expect(result.current).toBe(1)
    advance(1)
    expect(result.current).toBe(4)

    // Act: after a quiet second, the next change steps at once.
    advance(1500)
    rerender({ v: 5 })
    advance(0)

    // Assert
    expect(result.current).toBe(5)
  })

  it('does not step when the value comes back before the second is up', () => {
    const { result, rerender } = renderHook(({ v }) => useStepped(v, 1000), { initialProps: { v: 'a' } })
    rerender({ v: 'b' })
    advance(500)
    rerender({ v: 'a' })
    advance(2000)
    expect(result.current).toBe('a')
  })
})
