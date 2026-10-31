import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import type { FramesView, SessionSnapshot, VideoSettings } from '../../ipc/contract'
import type { MockOptions } from '../../ipc/mock/install'
import { addDays } from '../../lib/dates'
import { renderApp } from '../../test/renderApp'
import { stubLayout } from '../../test/layout'
import { usePlayer } from '../../state/player'
import { queryClient, queryKeys } from '../../state/queries'
import { frameIndexForDay } from './timelapseModel'

const frames = () => queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames ?? []
const index = () => usePlayer.getState().index

/** A frame clock: requestAnimationFrame callbacks run only when the test ticks. */
function installFrameClock() {
  let now = 1000
  let seq = 0
  const queue = new Map<number, FrameRequestCallback>()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    seq += 1
    queue.set(seq, cb)
    return seq
  })
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
    queue.delete(id)
  })
  return {
    /** Runs `times` display frames, `ms` apart, flushing image decodes in between. */
    async tick(ms: number, times = 1): Promise<void> {
      for (let i = 0; i < times; i++) {
        await act(async () => {
          now += ms
          const due = [...queue.values()]
          queue.clear()
          for (const cb of due) cb(now)
        })
      }
    },
  }
}

async function openTimelapse(opts: Partial<MockOptions> = {}) {
  // The player fetches frames only once it knows its width (UI review 2, L7).
  stubLayout(1200, 800)
  const app = await renderApp({ scenario: 'aligned', ...opts })
  await screen.findByRole('toolbar', { name: 'Playback' })
  await act(async () => usePlayer.getState().setIndex(0))
  return app
}

/** Replaces the session's video timeline (what the player paces itself by). */
function setTimeline(patch: Partial<VideoSettings>) {
  act(() => {
    queryClient.setQueryData<SessionSnapshot>(queryKeys.session, (s) => (s ? { ...s, video: { ...s.video, ...patch } } : s))
  })
}

/** One display frame slightly longer than 1/30 s, so 30 fps advances exactly one output frame per tick. */
const FRAME_MS = 34

async function play() {
  const clock = installFrameClock()
  fireEvent.keyDown(window, { key: ' ' })
  await clock.tick(0)
  return clock
}

describe('Seeking while playing (H4)', () => {
  it('a filmstrip click moves the playhead instead of being overwritten by the loop', async () => {
    // Arrange
    await openTimelapse()
    setTimeline({ crossfade: { frames: 0, easing: 'easeInOut' }, holdFirstSecs: 0, holdLastSecs: 0 })
    const clock = await play()
    await clock.tick(FRAME_MS, 5)
    expect(index()).toBeGreaterThan(0)
    const strip = within(screen.getByRole('listbox', { name: 'Frames near the playhead' }))
    const options = strip.getAllByRole('option')
    const last = options[options.length - 1] as HTMLElement
    const target = Number(/^Frame (\d+),/.exec(last.getAttribute('aria-label') ?? '')?.[1]) - 1

    // Act
    fireEvent.click(last)
    await clock.tick(FRAME_MS)

    // Assert
    expect(usePlayer.getState().playing).toBe(true)
    expect(index()).toBeGreaterThanOrEqual(target)
    expect(index()).toBeLessThanOrEqual(target + 1)
  })

  it('a ribbon seek moves the playhead and playback continues from there', async () => {
    // Arrange
    await openTimelapse()
    setTimeline({ crossfade: { frames: 0, easing: 'easeInOut' }, holdFirstSecs: 0, holdLastSecs: 0 })
    const first = frames()[0]?.dayKey ?? ''
    const day = addDays(`${first.slice(0, 4)}-01-01`, 800)
    const target = frameIndexForDay(frames(), day)
    const clock = await play()
    await clock.tick(FRAME_MS, 3)

    // Act
    fireEvent.change(screen.getByRole('slider', { name: 'Playhead date' }), { target: { value: '800' } })
    await clock.tick(FRAME_MS)
    const landed = index()
    await clock.tick(FRAME_MS, 3)

    // Assert
    expect(landed).toBeGreaterThanOrEqual(target)
    expect(landed).toBeLessThanOrEqual(target + 1)
    expect(index()).toBe(landed + 3)
  })

  it('⌥→ jumps a year ahead while playing', async () => {
    // Arrange
    await openTimelapse()
    setTimeline({ crossfade: { frames: 0, easing: 'easeInOut' }, holdFirstSecs: 0, holdLastSecs: 0 })
    const clock = await play()
    await clock.tick(FRAME_MS, 2)
    const shown = frames()[usePlayer.getState().settled]?.dayKey ?? ''
    const target = frameIndexForDay(frames(), `${Number(shown.slice(0, 4)) + 1}${shown.slice(4)}`)

    // Act
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
    await clock.tick(FRAME_MS)

    // Assert
    expect(index()).toBeGreaterThanOrEqual(target)
    expect(index()).toBeLessThanOrEqual(target + 1)
  })
})

describe('Playback pace (M7)', () => {
  it('plays at the video pace: with Blend 8 each day stays on screen for 9 output frames', async () => {
    // Arrange
    await openTimelapse()
    setTimeline({ pace: { mode: 'fps', fps: 30 }, crossfade: { frames: 8, easing: 'linear' }, holdFirstSecs: 0, holdLastSecs: 0 })
    const clock = await play()

    // Act
    await clock.tick(FRAME_MS, 8)
    const midBlend = index()
    await clock.tick(FRAME_MS)
    const nextDay = index()
    await clock.tick(FRAME_MS, 9)

    // Assert
    expect(midBlend).toBe(0)
    expect(nextDay).toBe(1)
    expect(index()).toBe(2)
  })

  it('holds the first frame for the first hold before the next day', async () => {
    // Arrange: one second of first hold at 30 fps = 30 output frames of day 0, then day 0's own frame.
    await openTimelapse()
    setTimeline({ pace: { mode: 'fps', fps: 30 }, crossfade: { frames: 0, easing: 'linear' }, holdFirstSecs: 1, holdLastSecs: 0 })
    act(() => usePlayer.setState({ index: frames().length - 1, settled: frames().length - 1 }))
    const clock = await play()

    // Act: the last frame wraps to the start of the video, where the first hold plays.
    await clock.tick(FRAME_MS)
    const wrapped = index()
    await clock.tick(FRAME_MS, 30)
    const held = index()
    await clock.tick(FRAME_MS)

    // Assert
    expect(wrapped).toBe(0)
    expect(held).toBe(0)
    expect(index()).toBe(1)
  })
})

describe('Frames that fail to load (M5)', () => {
  function failDecodesOf(photoId: string) {
    const ok = HTMLImageElement.prototype.decode
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (this: HTMLImageElement) {
      return this.src.includes(photoId) ? Promise.reject(new Error('404')) : ok.call(this)
    })
  }

  it('playback skips a frame whose image fails instead of freezing on it', async () => {
    // Arrange
    await openTimelapse()
    setTimeline({ crossfade: { frames: 0, easing: 'easeInOut' }, holdFirstSecs: 0, holdLastSecs: 0 })
    const bad = frames()[3]?.photoId ?? ''
    failDecodesOf(bad)
    act(() => queryClient.setQueryData<FramesView>(queryKeys.frames, (v) => (v ? { ...v, frames: v.frames.map((f) => ({ ...f, version: `${f.version}x` })) } : v)))
    const clock = await play()

    // Act
    await clock.tick(FRAME_MS, 6)

    // Assert
    expect(index()).toBeGreaterThan(3)
  })

  it('a paused frame that fails shows a placeholder, not an endless spinner', async () => {
    // Arrange
    await openTimelapse()
    const bad = frames()[5]?.photoId ?? ''
    failDecodesOf(bad)
    act(() => queryClient.setQueryData<FramesView>(queryKeys.frames, (v) => (v ? { ...v, frames: v.frames.map((f) => ({ ...f, version: `${f.version}x` })) } : v)))

    // Act
    await act(async () => usePlayer.getState().setIndex(5))

    // Assert
    expect(await screen.findByText('This frame couldn’t be loaded.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading frame')).toBeNull()
  })
})

describe('Drawing the canvas', () => {
  interface Draw {
    src: string
    alpha: number
    mode: string
  }

  /** A 2D context that records what is drawn, with the alpha and blend mode in effect. */
  function recordCanvas() {
    const draws: Draw[] = []
    const clears: number[] = []
    const ctx = {
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      drawImage(img: HTMLImageElement) {
        draws.push({ src: img.src, alpha: this.globalAlpha, mode: this.globalCompositeOperation })
      },
      clearRect() {
        clears.push(draws.length)
      },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    return { draws, clears }
  }

  const photo = (i: number) => frames()[i]?.photoId ?? ''

  it('a blend frame draws the next day over the current one at the plan’s weight', async () => {
    // Arrange: 1 blend frame between days, linear: output frame 1 is day 0 → day 1 at 50 %.
    stubLayout(800, 600)
    await openTimelapse()
    setTimeline({ pace: { mode: 'fps', fps: 30 }, crossfade: { frames: 1, easing: 'linear' }, holdFirstSecs: 0, holdLastSecs: 0 })
    const { draws } = recordCanvas()
    const clock = await play()

    // Act
    await clock.tick(FRAME_MS)

    // Assert
    const [base, blend] = draws.slice(-2)
    expect(base).toMatchObject({ alpha: 1, mode: 'source-over' })
    expect(base?.src).toContain(photo(0))
    expect(blend).toMatchObject({ alpha: 0.5, mode: 'source-over' })
    expect(blend?.src).toContain(photo(1))
    expect(index()).toBe(0)
  })

  it('onion skin overlays the previous day at its opacity, or as a difference', async () => {
    // Arrange
    stubLayout(800, 600)
    await openTimelapse()
    const { draws } = recordCanvas()

    // Act
    fireEvent.keyDown(window, { key: 'o' })
    await act(async () => usePlayer.getState().setIndex(5))
    const overlay = draws.at(-1)
    fireEvent.keyDown(window, { key: 'd' })
    await act(async () => undefined)
    const difference = draws.at(-1)

    // Assert
    expect(draws.at(-2)?.src).toContain(photo(5))
    expect(overlay).toMatchObject({ alpha: 0.5, mode: 'source-over' })
    expect(overlay?.src).toContain(photo(4))
    expect(difference).toMatchObject({ alpha: 1, mode: 'difference' })
  })

  it('a paused frame that failed clears the canvas behind the placeholder', async () => {
    // Arrange
    stubLayout(800, 600)
    await openTimelapse()
    // Outside the paused window around frame 0, so it is not decoded yet.
    const bad = photo(30)
    const ok = HTMLImageElement.prototype.decode
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (this: HTMLImageElement) {
      return this.src.includes(bad) ? Promise.reject(new Error('404')) : ok.call(this)
    })
    const { clears } = recordCanvas()

    // Act
    await act(async () => usePlayer.getState().setIndex(30))

    // Assert
    expect(await screen.findByText('This frame couldn’t be loaded.')).toBeInTheDocument()
    expect(clears.length).toBeGreaterThan(0)
  })
})

// UI review 2, L1: Play from frame 1 skipped the first hold (and the timecode
// read the hold's length there); Play on the last frame with loop off played
// only the tail hold.
describe('Play from either end', () => {
  it('from the first frame it plays the first hold, as the export does, and the timecode starts at 0', async () => {
    // Arrange
    await openTimelapse()
    setTimeline({ pace: { mode: 'fps', fps: 30 }, crossfade: { frames: 0, easing: 'linear' }, holdFirstSecs: 1, holdLastSecs: 0 })
    expect(within(screen.getByRole('toolbar', { name: 'Playback' })).getByText('0:00')).toBeInTheDocument()
    const clock = await play()

    // Act
    // Output frames 0–29 are the hold, 30 is day 0's own frame, 31 is day 1.
    await clock.tick(FRAME_MS, 30)
    const held = index()
    await clock.tick(FRAME_MS)

    // Assert
    expect(held).toBe(0)
    expect(index()).toBe(1)
    act(() => usePlayer.getState().pause())
  })

  it('on the last frame with loop off it starts again from the beginning', async () => {
    // Arrange
    await openTimelapse()
    setTimeline({ crossfade: { frames: 0, easing: 'easeInOut' }, holdFirstSecs: 0, holdLastSecs: 1 })
    act(() => {
      usePlayer.getState().setLoop(false)
      usePlayer.setState({ index: frames().length - 1, settled: frames().length - 1 })
    })
    const clock = await play()

    // Act
    await clock.tick(FRAME_MS, 3)

    // Assert
    expect(usePlayer.getState().playing).toBe(true)
    expect(index()).toBeLessThan(5)
    act(() => usePlayer.getState().pause())
  })
})
