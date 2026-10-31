// UI review 2, L6: the playback loop drew the whole canvas on every display
// frame even when the output frame hadn't changed, and a session refetch (a
// new but equal settings object) restarted the loop.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import type { VideoSettings } from '../../ipc/contract'
import { usePlayer } from '../../state/player'
import { usePlaybackLoop, usePlaybackPlan } from './usePlayback'
import { crossfadePlan } from '../../lib/video'

const video: VideoSettings = {
  pace: { mode: 'fps', fps: 10 },
  resolution: '1080p',
  quality: 'high',
  crossfade: { frames: 0, easing: 'linear' },
  caption: null,
  holdFirstSecs: 0,
  holdLastSecs: 0,
}

/** A display at `hz`: requestAnimationFrame runs only when the test ticks. */
function display() {
  let now = 1000
  const queue = new Map<number, FrameRequestCallback>()
  let seq = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    seq += 1
    queue.set(seq, cb)
    return seq
  })
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => void queue.delete(id))
  return (ms: number, times: number) => {
    for (let i = 0; i < times; i++) {
      act(() => {
        now += ms
        const due = [...queue.values()]
        queue.clear()
        for (const cb of due) cb(now)
      })
    }
  }
}

const PLAN = crossfadePlan(100, 0, 'linear')

function Loop({ draw, fps = 10 }: { draw: () => boolean; fps?: number }) {
  usePlaybackLoop(true, { plan: PLAN, fps, canShow: () => true, draw })
  return null
}

afterEach(() => {
  act(() => usePlayer.getState().resetPlayback())
})

describe('the playback loop', () => {
  it('draws once per output frame, not once per display frame', () => {
    // Arrange: 10 frames a second on a 60 Hz display.
    const tick = display()
    act(() => usePlayer.setState({ index: 0, settled: 0, playing: true, loop: true }))
    const draw = vi.fn(() => true)
    render(<Loop draw={draw} />)

    // Act: one second.
    tick(1000 / 60, 60)

    // Assert: about ten output frames (the first one included), never sixty draws.
    expect(draw.mock.calls.length).toBeGreaterThanOrEqual(9)
    expect(draw.mock.calls.length).toBeLessThanOrEqual(12)
  })

  // UI review 3, L3: while an output frame holds, a change of what is drawn (onion, difference,
  // opacity, the viewer, a resize) must still repaint, and a draw that couldn't paint is retried.
  it('repaints a held frame when the drawing changes, and retries a draw that could not paint', () => {
    // Arrange: one frame a second, so the output frame holds for many display frames.
    const tick = display()
    act(() => usePlayer.setState({ index: 0, settled: 0, playing: true, loop: true }))
    const first = vi.fn(() => false)
    const { rerender } = render(<Loop draw={first} fps={1} />)

    // Act + Assert: a draw that couldn't paint (no size yet) is tried again.
    tick(16, 3)
    expect(first.mock.calls.length).toBeGreaterThanOrEqual(3)

    // Act + Assert: once painted, the held frame isn't drawn again…
    const painting = vi.fn(() => true)
    rerender(<Loop draw={painting} fps={1} />)
    tick(16, 5)
    expect(painting).toHaveBeenCalledTimes(1)

    // …until the drawing itself changes (onion on, a resize).
    const changed = vi.fn(() => true)
    rerender(<Loop draw={changed} fps={1} />)
    tick(16, 5)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('keeps the same plan for an equal settings object (a session refetch)', () => {
    const { result, rerender } = renderHook(({ v }) => usePlaybackPlan(100, v), { initialProps: { v: video } })
    const first = result.current
    rerender({ v: { ...video, pace: { mode: 'fps', fps: 10 }, crossfade: { frames: 0, easing: 'linear' } } })
    expect(result.current).toBe(first)
    rerender({ v: { ...video, holdLastSecs: 1 } })
    expect(result.current).not.toBe(first)
  })
})
