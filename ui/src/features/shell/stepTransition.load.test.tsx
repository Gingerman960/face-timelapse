// Critique round 5, P1-3: the first visit to a screen cross-faded into its
// loading frame. A transition now starts only once the new screen's code is here.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useView } from '../../state/view'
import { TRANSITION_CLASS, useShownStep } from './stepTransition'

let release: () => void = () => undefined
let refuse: (error: Error) => void = () => undefined
vi.mock('./screens', () => ({
  loadScreen: vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        release = resolve
        refuse = reject
      }),
  ),
}))

type Doc = { startViewTransition?: unknown }
const doc = () => document as unknown as Doc

afterEach(() => {
  delete doc().startViewTransition
  document.documentElement.classList.remove(TRANSITION_CLASS)
})

describe('a step change to a screen whose code is still loading', () => {
  it('starts its transition only once the code is here', async () => {
    // Arrange
    const start = vi.fn((update: () => void) => {
      update()
      return { finished: Promise.resolve() }
    })
    doc().startViewTransition = start
    act(() => useView.getState().setStep('review'))
    const { result } = renderHook(() => useShownStep())

    // Act: the target changes; its code has not arrived.
    act(() => useView.getState().setStep('days'))
    await act(async () => undefined)

    // Assert: the old screen stays; then the code arrives and the change runs in one transition.
    expect(start).not.toHaveBeenCalled()
    expect(result.current).toBe('review')
    await act(async () => release())
    expect(start).toHaveBeenCalledTimes(1)
    expect(result.current).toBe('days')
  })

  it('still changes when the code fails to arrive (the screen’s boundary says so)', async () => {
    // Arrange
    const start = vi.fn((update: () => void) => {
      update()
      return { finished: Promise.resolve() }
    })
    doc().startViewTransition = start
    act(() => useView.getState().setStep('review'))
    const { result } = renderHook(() => useShownStep())

    // Act
    act(() => useView.getState().setStep('scan'))
    await act(async () => refuse(new Error('offline')))

    // Assert
    expect(start).toHaveBeenCalledTimes(1)
    expect(result.current).toBe('scan')
  })
})
