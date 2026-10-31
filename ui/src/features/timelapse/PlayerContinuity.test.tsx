// Critique round 5 on the player's continuity and its full-window viewer:
// - P1-2: the print travels by its day (data-vt-print, --vt-print), the
//   transition waits until the player's frame is painted (a poster under the
//   canvas), and Days opens on the playhead's day;
// - P2-17: F carries the date as a plate burned into the frame, and the viewer
//   dialog takes focus and gives it back.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { FramesView } from '../../ipc/contract'
import { formatDay } from '../../lib/dates'
import { renderApp } from '../../test/renderApp'
import { stubLayout } from '../../test/layout'
import { usePlayer } from '../../state/player'
import { queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'
import { TRANSITION_CLASS, vtPrintName } from '../shell/stepTransition'

const frames = () => queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames ?? []
const title = () => screen.getByRole('heading', { level: 1 })
const playerFrame = () => document.querySelector('.player-frame') as HTMLElement
const viewer = () => screen.queryByRole('dialog', { name: 'Full-window viewer' })

type Doc = { startViewTransition?: unknown }
const doc = () => document as unknown as Doc

async function openTimelapse() {
  const app = await renderApp({ scenario: 'aligned' })
  await screen.findByRole('toolbar', { name: 'Playback' })
  await act(async () => usePlayer.getState().setIndex(0))
  return app
}

const jsdomDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode')

afterEach(() => {
  delete doc().startViewTransition
  if (jsdomDecode) Object.defineProperty(HTMLImageElement.prototype, 'decode', jsdomDecode)
  else delete (HTMLImageElement.prototype as { decode?: unknown }).decode
  document.documentElement.classList.remove(TRANSITION_CLASS)
  vi.restoreAllMocks()
})

describe('The print travels by its day (P1-2)', () => {
  it('names the player frame by the day on show, not by its role', async () => {
    // Arrange
    await openTimelapse()

    // Act
    await act(async () => usePlayer.getState().setIndex(7))

    // Assert
    expect(playerFrame()).toHaveAttribute('data-vt-print')
    expect(playerFrame().style.getPropertyValue('--vt-print')).toBe(vtPrintName(frames()[7]?.dayKey ?? ''))
  })

  it('keeps the Days selection on the playhead’s day each time the player settles', async () => {
    // Arrange
    await openTimelapse()

    // Act + Assert: paused, at once.
    await act(async () => usePlayer.getState().setIndex(12))
    expect(useView.getState().activeDay).toBe(frames()[12]?.dayKey)

    // Playing: with the settled index, not every frame.
    act(() => usePlayer.setState({ index: 30 }))
    expect(useView.getState().activeDay).toBe(frames()[12]?.dayKey)
    act(() => usePlayer.setState({ settled: 30 }))
    expect(useView.getState().activeDay).toBe(frames()[30]?.dayKey)
  })

  it('paints a poster of the frame on show under the canvas', async () => {
    // Arrange
    stubLayout(1200, 800)
    await openTimelapse()

    // Act
    await act(async () => usePlayer.getState().setIndex(4))

    // Assert: the poster first, so the canvas draws over it once it can.
    const poster = playerFrame().querySelector('img.frame-poster') as HTMLImageElement
    expect(poster).toHaveAttribute('alt', '')
    expect(poster.getAttribute('src')).toContain(frames()[4]?.photoId)
    expect(poster.compareDocumentPosition(playerFrame().querySelector('canvas') as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the poster still while playing, so playback never loads it again', async () => {
    // Arrange
    stubLayout(1200, 800)
    await openTimelapse()
    const poster = () => playerFrame().querySelector('img.frame-poster')?.getAttribute('src')
    const before = poster()

    // Act
    act(() => usePlayer.setState({ playing: true }))
    act(() => usePlayer.setState({ index: 40, settled: 40 }))

    // Assert
    expect(poster()).toBe(before)
    act(() => usePlayer.getState().pause())
    expect(poster()).toContain(frames()[40]?.photoId)
  })

  it('the transition into the player waits until the poster has decoded', async () => {
    // Arrange: on Days, with transitions that run their update and report when it settles.
    stubLayout(1200, 800)
    await openTimelapse()
    act(() => useView.getState().setStep('days'))
    await waitFor(() => expect(title()).toHaveTextContent('Days'))
    const pending: Array<() => void> = []
    const decode = vi.fn(() => new Promise<void>((resolve) => pending.push(resolve)))
    Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, writable: true, value: decode })
    let update: Promise<void> | undefined
    doc().startViewTransition = (cb: () => Promise<void>) => {
      update = cb()
      return { finished: update }
    }
    let captured = false

    // Act
    act(() => useView.getState().setStep('timelapse'))
    await waitFor(() => expect(update).toBeDefined())
    void update?.then(() => (captured = true))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))

    // Assert: held for the poster, then captured once it decoded.
    expect(decode).toHaveBeenCalled()
    expect(captured).toBe(false)
    await act(async () => {
      for (const resolve of pending) resolve()
      await update
    })
    expect(captured).toBe(true)
  })
})

describe('The full-window viewer (F)', () => {
  it('takes focus when it opens and gives it back when it closes', async () => {
    // Arrange
    await openTimelapse()
    const play = screen.getByRole('button', { name: 'Play' })
    play.focus()

    // Act
    fireEvent.keyDown(window, { key: 'f' })

    // Assert
    const dialog = await screen.findByRole('dialog', { name: 'Full-window viewer' })
    expect(dialog).toHaveFocus()
    expect(dialog).toHaveAttribute('tabindex', '-1')

    // Act
    fireEvent.keyDown(dialog, { key: 'Escape' })

    // Assert
    await waitFor(() => expect(viewer()).toBeNull())
    expect(play).toHaveFocus()
  })

  it('Space still plays while the viewer holds focus', async () => {
    // Arrange
    await openTimelapse()
    fireEvent.keyDown(window, { key: 'f' })
    const dialog = await screen.findByRole('dialog', { name: 'Full-window viewer' })

    // Act
    fireEvent.keyDown(dialog, { key: ' ' })

    // Assert
    expect(usePlayer.getState().playing).toBe(true)
    act(() => usePlayer.getState().pause())
  })

  it('carries the date into the full window as a plate burned into the frame, at frame rate', async () => {
    // Arrange
    await openTimelapse()
    await act(async () => usePlayer.getState().setIndex(5))
    expect(playerFrame().querySelector('.frame-plate')).toBeNull()

    // Act
    fireEvent.keyDown(window, { key: 'f' })
    const dialog = await screen.findByRole('dialog', { name: 'Full-window viewer' })

    // Assert
    const plate = playerFrame().querySelector('.frame-plate') as HTMLElement
    expect(plate).toHaveTextContent(formatDay(frames()[5]?.dayKey ?? ''))
    expect(dialog).toHaveAttribute('aria-describedby', plate.id)
    act(() => usePlayer.setState({ index: 9 }))
    expect(plate).toHaveTextContent(formatDay(frames()[9]?.dayKey ?? ''))
  })
})
