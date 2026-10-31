// Critique round 4 on the player: one tab stop on the filmstrip (item 21), the
// aligning strip's develop model (item 13), the strip folding away and lights-out
// while playing (P1-2, signature moment 1), and F lifting the same print in a View
// Transition (signature moment 3).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FramesView, SessionSnapshot } from '../../ipc/contract'
import type { MockOptions } from '../../ipc/mock/install'
import { renderApp } from '../../test/renderApp'
import { stubLayout } from '../../test/layout'
import { startAlign, useJobs } from '../../state/jobs'
import { usePlayer } from '../../state/player'
import { queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'

const frames = () => queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames ?? []
const session = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session) as SessionSnapshot
const title = () => screen.getByRole('heading', { level: 1 })

async function openTimelapse(opts: Partial<MockOptions> = {}) {
  const app = await renderApp({ scenario: 'aligned', ...opts })
  await screen.findByRole('toolbar', { name: 'Playback' })
  await act(async () => usePlayer.getState().setIndex(0))
  return app
}

// Critique round 4, item 21: the filmstrip had 19 tab stops.
describe('Filmstrip keys (roving tabindex)', () => {
  const strip = () => screen.getByRole('listbox', { name: 'Frames near the playhead' })
  const tabStops = () => [...strip().querySelectorAll('[role="option"]')].filter((o) => o.getAttribute('tabindex') === '0')

  it('is one tab stop, on the playhead frame', async () => {
    // Arrange
    stubLayout(1200, 800)
    await openTimelapse()
    await act(async () => usePlayer.getState().setIndex(40))

    // Assert
    expect(strip()).toHaveAttribute('aria-orientation', 'horizontal')
    expect(tabStops()).toHaveLength(1)
    expect(tabStops()[0]).toHaveAttribute('aria-selected', 'true')
    expect(strip().querySelectorAll('[role="option"][tabindex="-1"]')).toHaveLength(14)
  })

  it('arrows move the playhead (⇧ ten) and focus follows; Home and End go to the ends; the player does not step twice', async () => {
    // Arrange
    stubLayout(1200, 800)
    await openTimelapse()
    await act(async () => usePlayer.getState().setIndex(40))
    const focusedFrame = () => (document.activeElement as HTMLElement).getAttribute('aria-label')
    ;(tabStops()[0] as HTMLElement).focus()

    // Act + Assert
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })
    expect(usePlayer.getState().index).toBe(41)
    expect(focusedFrame()).toBe(`Frame 42, ${frames()[41]?.dayKey}`)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft', shiftKey: true })
    expect(usePlayer.getState().index).toBe(31)
    expect(focusedFrame()).toBe(`Frame 32, ${frames()[31]?.dayKey}`)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    expect(usePlayer.getState().index).toBe(frames().length - 1)
    expect(focusedFrame()).toBe(`Frame ${frames().length}, ${frames()[frames().length - 1]?.dayKey}`)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' })
    expect(usePlayer.getState().index).toBe(0)
    expect(focusedFrame()).toBe(`Frame 1, ${frames()[0]?.dayKey}`)
    expect(tabStops()).toHaveLength(1)
  })

  it('Tab leaves the strip in one press', async () => {
    // Arrange
    stubLayout(1200, 800)
    await openTimelapse()
    ;(tabStops()[0] as HTMLElement).focus()

    // Act
    await userEvent.tab()

    // Assert
    expect(strip().contains(document.activeElement)).toBe(false)
  })
})

// Critique round 4, item 13: aligning frames surfaced out of white canvas slabs in light.
describe('Aligning filmstrip develop-in', () => {
  it('develops the newest frames by image opacity over the latent rebate tone, not a canvas overlay', async () => {
    // Arrange
    stubLayout(1200, 800)
    const { backend } = await openTimelapse()
    backend.configure({ speed: 'fast' })

    // Act
    await act(async () => {
      await startAlign(session().render)
    })
    await waitFor(() => expect(useJobs.getState().align.recent.length).toBeGreaterThan(3))

    // Assert
    const strip = screen.getByRole('listbox', { name: 'Frames as they finish' })
    const options = [...strip.querySelectorAll('[role="option"]')]
    expect(options.filter((o) => o.hasAttribute('data-develop')).length).toBeGreaterThan(0)
    expect(strip.querySelectorAll('.develop')).toHaveLength(0)
    expect(options.filter((o) => o.getAttribute('tabindex') === '0')).toHaveLength(1)
  })
})

// Critique round 4, P1-2 and signature moment 1.
describe('Playing: the strip folds away and the lights go out', () => {
  const lights = () => document.documentElement.dataset.lights
  const player = () => document.querySelector('.player') as HTMLElement

  it('Space folds the strip away (the frame takes its place) and dims the chrome; a pointer move or a pause brings it back', async () => {
    // Arrange
    await openTimelapse()
    expect(player()).toHaveAttribute('data-playing', 'false')
    expect(lights()).toBe('on')

    // Act
    fireEvent.keyDown(document.body, { key: ' ' })

    // Assert
    expect(usePlayer.getState().playing).toBe(true)
    expect(player()).toHaveAttribute('data-playing', 'true')
    expect(lights()).toBe('out')
    fireEvent.pointerMove(window, { clientX: 12, clientY: 30 })
    expect(lights()).toBe('on')
    fireEvent.keyDown(document.body, { key: ' ' })
    expect(usePlayer.getState().playing).toBe(false)
    expect(player()).toHaveAttribute('data-playing', 'false')
    expect(lights()).toBe('on')
  })

  // The strip is out of sight while playing: it must not re-render and fetch thumbnails at the settle rate.
  it('the folded strip holds still while playing and catches up on pause', async () => {
    // Arrange
    stubLayout(1200, 800)
    await openTimelapse()
    const options = () => [...screen.getByRole('listbox', { name: 'Frames near the playhead' }).querySelectorAll('[role="option"]')]
    const before = options().map((o) => o.getAttribute('aria-label'))
    fireEvent.keyDown(document.body, { key: ' ' })

    // Act: playback settles further on.
    act(() => usePlayer.setState({ index: 120, settled: 120 }))

    // Assert
    expect(options().map((o) => o.getAttribute('aria-label'))).toEqual(before)
    act(() => usePlayer.getState().pause())
    expect(options().find((o) => o.getAttribute('aria-selected') === 'true')).toHaveAccessibleName(`Frame 121, ${frames()[120]?.dayKey}`)
  })

  it('leaving the player clears lights-out, also mid-play', async () => {
    // Arrange
    await openTimelapse()
    fireEvent.keyDown(document.body, { key: ' ' })
    expect(lights()).toBe('out')

    // Act: to the sheet, then to another screen.
    act(() => useView.getState().setTimelapseMode('grid'))

    // Assert
    expect(lights()).toBeUndefined()
    act(() => useView.getState().setTimelapseMode('player'))
    await screen.findByRole('toolbar', { name: 'Playback' })
    act(() => useView.getState().setStep('days'))
    await waitFor(() => expect(title()).toHaveTextContent('Days'))
    expect(lights()).toBeUndefined()
    act(() => usePlayer.getState().pause())
  })
})

// Critique round 4, signature moment 3: F lifts the same print to the full window.
describe('F in a View Transition', () => {
  afterEach(() => {
    delete (document as { startViewTransition?: unknown }).startViewTransition
    document.documentElement.classList.remove('vt')
  })

  it('names the player frame for the transition and opens and closes the viewer inside one', async () => {
    // Arrange
    await openTimelapse()
    const start = vi.fn((update: () => void) => {
      update()
      return { finished: Promise.resolve() }
    })
    ;(document as { startViewTransition?: unknown }).startViewTransition = start
    expect(document.querySelectorAll('.player-frame')).toHaveLength(1)

    // Act
    fireEvent.keyDown(window, { key: 'f' })

    // Assert
    expect(start).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('dialog', { name: 'Full-window viewer' })).toBeInTheDocument()
    expect(document.querySelector('.player-frame')).toHaveClass('viewer-frame')

    // Act
    fireEvent.keyDown(window, { key: 'Escape' })

    // Assert
    expect(start).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Full-window viewer' })).toBeNull())
  })

  // UI review 5, L2: both presses read the state from before either transition applied.
  it('F pressed twice before a transition lands toggles twice: the viewer ends closed', async () => {
    // Arrange: transitions that apply their update a frame later, as a browser does.
    await openTimelapse()
    ;(document as { startViewTransition?: unknown }).startViewTransition = (update: () => void) => {
      const done = new Promise<void>((resolve) =>
        setTimeout(() => {
          update()
          resolve()
        }, 16),
      )
      return { ready: done, updateCallbackDone: done, finished: done }
    }

    // Act
    fireEvent.keyDown(window, { key: 'f' })
    fireEvent.keyDown(window, { key: 'f' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 80)))

    // Assert
    expect(usePlayer.getState().viewer).toBe(false)
  })
})
