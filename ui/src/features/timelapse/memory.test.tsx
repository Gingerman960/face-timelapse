// HIGH-3: WebKit reached 0.98 GB during align and grew over a session. These
// tests measure what the Timelapse holds decoded (live Image objects, canvas
// backing stores, mounted <img>) and pin the bounds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FramesView } from '../../ipc/contract'
import { renderApp } from '../../test/renderApp'
import { stubLayout } from '../../test/layout'
import { usePlayer } from '../../state/player'
import { queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'
import { DECODED_BUDGET_BYTES, decodedFrameBytes, preloadWindow } from './frameBuffer'

/** Every Image the app creates, so a test can count the ones still holding a picture. */
let made: HTMLImageElement[] = []
const live = () => made.filter((img) => (img.getAttribute('src') ?? '') !== '').length

beforeEach(() => {
  made = []
  const Original = window.Image
  vi.stubGlobal(
    'Image',
    class extends Original {
      constructor(width?: number, height?: number) {
        super(width, height)
        made.push(this)
      }
    },
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const frames = () => queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames ?? []

async function openPlayer() {
  // 1200 px boxes at dpr 1: the frame asks for the 1280 px bucket (about 8.7 MB decoded per frame).
  stubLayout(1200, 800)
  const app = await renderApp({ scenario: 'aligned' })
  await screen.findByRole('toolbar', { name: 'Playback' })
  return app
}

/** Lets every queued decode finish, so the buffer holds its whole window. */
async function settle(): Promise<void> {
  for (let k = 0; k < 30; k++) await act(async () => {})
}

/** Plays through `n` frames by moving the playhead like the playback loop does; returns the live images once settled. */
async function playThrough(n: number): Promise<number> {
  act(() => usePlayer.setState({ playing: true, index: 0, settled: 0 }))
  for (let i = 0; i < n; i++) act(() => usePlayer.setState({ index: i }))
  await settle()
  return live()
}

describe('preload window (HIGH-3)', () => {
  it('keeps the generous window for small frames', () => {
    // 640 px bucket at 3:4: about 2.2 MB a frame.
    expect(preloadWindow(true, decodedFrameBytes(640, 3 / 4))).toEqual({ ahead: 48, behind: 8 })
    expect(preloadWindow(false, decodedFrameBytes(640, 3 / 4))).toEqual({ ahead: 12, behind: 12 })
  })

  it('shrinks the window for large frames so the decoded frames fit the budget', () => {
    // 1280 px bucket at 3:4: about 8.7 MB a frame, 21 fit in 192 MB.
    const big = decodedFrameBytes(1280, 3 / 4)
    expect(big).toBe(1280 * 1707 * 4)
    expect(preloadWindow(true, big)).toEqual({ ahead: 18, behind: 2 })
    expect(preloadWindow(false, big)).toEqual({ ahead: 10, behind: 10 })
    // The onion skin's reference frame takes one place.
    expect(preloadWindow(false, big, 1)).toEqual({ ahead: 9, behind: 9 })
  })

  it('never goes below a few frames around the playhead', () => {
    expect(preloadWindow(false, DECODED_BUDGET_BYTES)).toEqual({ ahead: 4, behind: 4 })
    expect(preloadWindow(true, DECODED_BUDGET_BYTES)).toEqual({ ahead: 7, behind: 1 })
    expect(preloadWindow(true, 0)).toEqual({ ahead: 48, behind: 8 })
  })
})

describe('decoded frames held by the player (HIGH-3)', () => {
  it('a play-through keeps the decoded frames within the byte budget', async () => {
    // Arrange
    await openPlayer()
    const aspect = 3 / 4
    const perFrame = decodedFrameBytes(1280, aspect)
    const budgetFrames = Math.floor(DECODED_BUDGET_BYTES / perFrame)

    // Act: before this fix the window held 57 frames while playing (about 507 MB at this size).
    const playing = await playThrough(Math.min(300, frames().length))
    act(() => usePlayer.getState().pause())
    await settle()
    const paused = live()

    // Assert: 21 frames, about 184 MB, playing or paused.
    expect(budgetFrames).toBe(21)
    expect(playing).toBe(budgetFrames)
    expect(paused).toBe(budgetFrames)
    expect(playing * perFrame).toBeLessThanOrEqual(DECODED_BUDGET_BYTES)
  })

  it('the reference frame is decoded only while the onion skin shows it', async () => {
    // Arrange
    await openPlayer()
    const reference = () => made.filter((img) => (img.getAttribute('src') ?? '').includes('reference')).length

    // Assert
    expect(reference()).toBe(0)
    act(() => useView.getState().setOnion({ onion: true, onionSource: 'reference' }))
    await waitFor(() => expect(reference()).toBe(1))
  })

  it('leaving the Timelapse releases every decoded frame and the canvas backing store', async () => {
    // Arrange
    // A 2D context for the player's frame canvas only (the ribbon keeps jsdom's null).
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return this.closest('.frame') ? { drawImage: () => undefined, clearRect: () => undefined, globalAlpha: 1, globalCompositeOperation: 'source-over' } : null
    } as unknown as typeof HTMLCanvasElement.prototype.getContext
    try {
      await openPlayer()
      await waitFor(() => expect(live()).toBeGreaterThan(0))
      const canvas = screen.getByRole('img', { name: /^Frame for / }) as HTMLCanvasElement
      await waitFor(() => expect(canvas.width * canvas.height).toBeGreaterThan(0))

      // Act: go to Days (⌘4). While its code loads, React keeps the Timelapse
      // mounted but hidden; hiding must already release what it decoded.
      fireEvent.keyDown(window, { key: '4', metaKey: true, ctrlKey: true })
      await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Days'))

      // Assert
      expect(live()).toBe(0)
      expect(canvas.width * canvas.height).toBe(0)
      await waitFor(() => expect(canvas.isConnected).toBe(false))
      expect(live()).toBe(0)
    } finally {
      HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
    }
  })
})

describe('thumbnails mounted by the sheet (HIGH-3)', () => {
  it('keeps only the visible rows (plus overscan) mounted while scrolling', async () => {
    // Arrange
    await openPlayer()
    await userEvent.click(screen.getByRole('radio', { name: 'Sheet' }))
    const grid = await screen.findByLabelText('All aligned frames')
    const mounted = () => grid.querySelectorAll('img').length
    const atTop = mounted()

    // Act: scroll to the middle and to the end.
    let most = atTop
    for (const top of [20_000, 40_000, 1e9]) {
      act(() => {
        grid.scrollTop = top
        fireEvent.scroll(grid)
      })
      most = Math.max(most, mounted())
    }

    // Assert: a few rows of 12, never the 3,547 frames.
    expect(atTop).toBeGreaterThan(0)
    expect(most).toBeLessThanOrEqual(12 * 12)
    expect(most).toBeLessThan(frames().length / 20)
  })
})
