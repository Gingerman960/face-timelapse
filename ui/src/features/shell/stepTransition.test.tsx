// Critique round 4, P1-8: screens hard-cut and the first visit flashed an empty
// frame. A step change now runs in a View Transition, and screen code is
// fetched while idle so the transition captures the real screen.
import { Suspense, useEffect, useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient, queryKeys } from '../../state/queries'
import type { SessionSnapshot } from '../../ipc/contract'
import { renderApp } from '../../test/renderApp'
import { startAlign, useJobs } from '../../state/jobs'
import { useView } from '../../state/view'
import { canViewTransition, HOLD_CAP_MS, holdTransition, isCapturing, runInViewTransition, TRANSITION_CLASS, useShownStep, useTransitionHold } from './stepTransition'
import { IDLE_FALLBACK_MS, preloadable, preloadScreen, preloadScreensWhenIdle, ReviewScreen } from './screens'

type Doc = { startViewTransition?: unknown }
const doc = () => document as unknown as Doc

function fakeTransitions() {
  let finish: () => void = () => undefined
  const start = vi.fn((update: () => void) => {
    update()
    return { finished: new Promise<void>((resolve) => (finish = resolve)) }
  })
  ;doc().startViewTransition = start
  return { start, finish: () => finish() }
}

afterEach(() => {
  delete doc().startViewTransition
  document.documentElement.classList.remove(TRANSITION_CLASS)
})

describe('a step change in a View Transition', () => {
  it('applies at once where the API is missing', () => {
    const apply = vi.fn()
    expect(canViewTransition()).toBe(false)
    runInViewTransition(apply)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('names things only while the transition runs, and applies inside it', async () => {
    // Arrange
    const { start, finish } = fakeTransitions()
    const apply = vi.fn(() => expect(document.documentElement).toHaveClass(TRANSITION_CLASS))

    // Act
    runInViewTransition(apply)

    // Assert
    expect(start).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(document.documentElement).toHaveClass(TRANSITION_CLASS)
    await act(async () => finish())
    expect(document.documentElement).not.toHaveClass(TRANSITION_CLASS)
  })

  it('a skipped transition still clears the names', async () => {
    ;doc().startViewTransition = (update: () => void) => {
      update()
      const skipped = () => Promise.reject(new DOMException('Transition was skipped', 'AbortError'))
      // Every promise of a skipped transition rejects; none may surface as an unhandled rejection.
      return { finished: skipped(), ready: skipped(), updateCallbackDone: skipped() }
    }
    runInViewTransition(() => undefined)
    await act(async () => undefined)
    expect(document.documentElement).not.toHaveClass(TRANSITION_CLASS)
  })

  it('skips the transition while the window is hidden', () => {
    const { start } = fakeTransitions()
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const apply = vi.fn()
    runInViewTransition(apply)
    expect(start).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledTimes(1)
    hidden.mockRestore()
  })

  // Critique round 5, P1-2: the player's frame must be painted before the new state is captured.
  it('captures the new state once what it holds for is ready', async () => {
    // Arrange
    let update: Promise<void> | undefined
    doc().startViewTransition = (cb: () => Promise<void>) => {
      update = cb()
      return { finished: update }
    }
    let release: () => void = () => undefined
    const painted = new Promise<void>((resolve) => (release = resolve))
    let captured = false

    // Act
    runInViewTransition(() => holdTransition(painted))
    void update?.then(() => (captured = true))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))

    // Assert: still waiting; then released.
    expect(captured).toBe(false)
    release()
    await act(async () => update)
    expect(captured).toBe(true)
  })

  it('never holds the capture longer than the cap', async () => {
    vi.useFakeTimers()
    try {
      let update: Promise<void> | undefined
      doc().startViewTransition = (cb: () => Promise<void>) => {
        update = cb()
        return { finished: update }
      }
      let captured = false
      runInViewTransition(() => holdTransition(new Promise(() => undefined)))
      void update?.then(() => (captured = true))
      await vi.advanceTimersByTimeAsync(HOLD_CAP_MS - 1)
      expect(captured).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(captured).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a screen mounted still loading holds the capture until it is ready', async () => {
    // Arrange: the new state mounts a screen that is still waiting for its data.
    let update: Promise<void> | undefined
    doc().startViewTransition = (cb: () => Promise<void>) => {
      update = cb()
      return { finished: update }
    }
    const api: { mount: (on: boolean) => void; ready: (on: boolean) => void } = { mount: () => undefined, ready: () => undefined }
    function Loading() {
      const [waiting, setWaiting] = useState(true)
      useEffect(() => {
        api.ready = (on) => setWaiting(!on)
      }, [])
      useTransitionHold(waiting)
      return null
    }
    function Harness() {
      const [on, setOn] = useState(false)
      useEffect(() => {
        api.mount = setOn
      }, [])
      return on ? <Loading /> : null
    }
    render(<Harness />)
    let captured = false

    // Act
    runInViewTransition(() => api.mount(true))
    void update?.then(() => (captured = true))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))

    // Assert
    expect(captured).toBe(false)
    act(() => api.ready(true))
    await act(async () => update)
    expect(captured).toBe(true)
  })

  it('says it is capturing only while a transition renders the new state', async () => {
    let update: Promise<void> | undefined
    doc().startViewTransition = (cb: () => Promise<void>) => {
      update = cb()
      return { finished: update }
    }
    let inside = false
    expect(isCapturing()).toBe(false)
    runInViewTransition(() => (inside = isCapturing()))
    await act(async () => update)
    expect(inside).toBe(true)
    expect(isCapturing()).toBe(false)
  })

  it('a hold outside a transition does nothing', () => {
    expect(() => holdTransition(Promise.resolve())).not.toThrow()
  })

  it('without the API the screen on show is the target step itself', () => {
    const { result } = renderHook(() => useShownStep())
    act(() => useView.getState().setStep('days'))
    expect(result.current).toBe('days')
  })
})

describe('screen code fetched ahead of a visit', () => {
  // Critique round 5, P1-3: WebKit may lack requestIdleCallback, so nothing was fetched ahead.
  it('falls back to a short timer where the browser cannot say when it is idle, and can be cancelled', () => {
    // Arrange: no requestIdleCallback (jsdom, like WebKit).
    const set = vi.spyOn(window, 'setTimeout')
    const clear = vi.spyOn(window, 'clearTimeout')

    // Act
    const stop = preloadScreensWhenIdle()
    stop()

    // Assert
    expect(set).toHaveBeenCalledWith(expect.any(Function), IDLE_FALLBACK_MS)
    expect(clear).toHaveBeenCalledWith(set.mock.results[0]?.value)
  })

  it('waits for an idle moment where the browser offers one, and can be cancelled', () => {
    const idle = vi.fn((cb: IdleRequestCallback) => {
      cb({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline)
      return 7
    })
    const cancel = vi.fn()
    Object.assign(window, { requestIdleCallback: idle, cancelIdleCallback: cancel })
    const stop = preloadScreensWhenIdle()
    expect(idle).toHaveBeenCalledTimes(1)
    stop()
    expect(cancel).toHaveBeenCalledWith(7)
    delete (window as Partial<Window>).requestIdleCallback
    delete (window as Partial<Window>).cancelIdleCallback
  })

  it('a screen whose code is here renders directly, without a loading frame', async () => {
    // Arrange: fetch Review's code ahead (a ledger hover).
    preloadScreen('review')
    await act(async () => {
      await import('../review/ReviewScreen')
    })

    // Act: a screen that is not mounted inside the app renders nothing without its data,
    // but must not suspend (no fallback).
    render(
      <SuspenseProbe>
        <ReviewScreen />
      </SuspenseProbe>,
    )

    // Assert
    expect(screen.queryByText('loading')).toBeNull()
  })
})

/** A Suspense boundary whose fallback names itself, to see whether its children suspended. */
function SuspenseProbe({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<span>loading</span>}>{children}</Suspense>
    </QueryClientProvider>
  )
}

/** Like a browser: the update callback runs a frame later, after the old screen is captured. */
function deferredTransitions() {
  doc().startViewTransition = (update: () => void) => {
    const done = new Promise<void>((resolve) =>
      setTimeout(() => {
        update()
        resolve()
      }, 16),
    )
    return { ready: done, updateCallbackDone: done, finished: done.then(() => new Promise<void>((r) => setTimeout(r, 30))) }
  }
}

const settle = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

// UI review 5, H1: the step was applied inside the transition's update callback, a frame late,
// so the step router still saw the old step and overrode the new one.
describe('a step change while View Transitions run a frame late', () => {
  it('a failed align still lands on Days (the router sees the new step at once)', async () => {
    // Arrange
    deferredTransitions()
    await renderApp({ scenario: 'aligned', speed: 'fast', fail: { alignMidway: 'diskFull' } })
    fireEvent.keyDown(window, { key: '4', metaKey: true, ctrlKey: true })
    await waitFor(() => expect(useView.getState().step).toBe('days'))
    const session = queryClient.getQueryData<SessionSnapshot>(queryKeys.session) as SessionSnapshot

    // Act
    await act(async () => {
      await startAlign(session.render)
    })
    await waitFor(() => expect(useJobs.getState().activeKind).toBeNull(), { timeout: 5000 })
    await settle(300)

    // Assert: the target and the screen on show agree.
    expect(useView.getState().step).toBe('days')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Days')
  })

  it('the step is set at once for logic, the screen follows in the transition, and the last of rapid changes wins', async () => {
    // Arrange
    deferredTransitions()
    await renderApp({ scenario: 'aligned' })
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Timelapse'))

    // Act: three changes before any transition applies.
    act(() => {
      useView.getState().setStep('days')
      useView.getState().setStep('review')
      useView.getState().setStep('days')
    })

    // Assert: logic sees the target at once; the screen catches up to the last one.
    expect(useView.getState().step).toBe('days')
    await settle(200)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Days'))
  })
})

// UI review 5, L3: a rejected import stuck, so a failed idle preload broke that screen until reload.
describe('a screen whose code failed to load', () => {
  it('is asked for again on the next load', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ default: () => null })
    const screenCode = preloadable(loader)
    await expect(screenCode.load()).rejects.toThrow('offline')
    await expect(screenCode.load()).resolves.toBeInstanceOf(Function)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

