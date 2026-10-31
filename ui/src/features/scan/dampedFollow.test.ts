// Critique round 4, P2-15: following the newest frame jumped a row at a time,
// about four times a second. The sheet now glides there on a critically
// damped spring, which a new target retargets mid-flight and a user scroll stops.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { dampStep, isSettled, useDampedFollow, type DampState } from './dampedFollow'

const FRAME_MS = 1000 / 60

function run(from: DampState, target: number, frames: number): DampState[] {
  const out: DampState[] = []
  let s = from
  for (let i = 0; i < frames; i++) {
    s = dampStep(s, target, FRAME_MS)
    out.push(s)
  }
  return out
}

describe('dampStep: a critically damped follow', () => {
  it('eases toward the target without overshooting, within 2 % after about 250 ms', () => {
    // Act
    const path = run({ pos: 0, vel: 0 }, 1000, 15).map((s) => s.pos)

    // Assert
    expect(path[0]).toBeGreaterThan(0)
    expect(path[0]).toBeLessThan(100)
    expect(path.every((p, i) => i === 0 || p >= (path[i - 1] ?? 0))).toBe(true)
    expect(Math.max(...path)).toBeLessThanOrEqual(1000)
    expect(1000 - (path.at(-1) ?? 0)).toBeLessThan(20)
  })

  it('carries its speed into a new target, so a retarget never jerks', () => {
    // Arrange: five frames toward 1000.
    const before = run({ pos: 0, vel: 0 }, 1000, 5)
    const last = before.at(-1) as DampState
    const lastStep = last.pos - (before.at(-2) as DampState).pos

    // Act: the next row arrives; the target moves on.
    const next = dampStep(last, 1400, FRAME_MS)

    // Assert: still moving the same way, at a similar speed.
    const step = next.pos - last.pos
    expect(step).toBeGreaterThan(lastStep * 0.5)
    expect(step).toBeLessThan(lastStep * 2)
  })

  it('a long stalled frame lands without overshooting', () => {
    expect(dampStep({ pos: 0, vel: 0 }, 1000, 2000).pos).toBeLessThanOrEqual(1000)
  })

  it('is settled only when it is both close and slow', () => {
    expect(isSettled({ pos: 999.8, vel: 3 }, 1000)).toBe(true)
    expect(isSettled({ pos: 999.8, vel: 400 }, 1000)).toBe(false)
    expect(isSettled({ pos: 990, vel: 0 }, 1000)).toBe(false)
  })
})

describe('useDampedFollow', () => {
  let frames: FrameRequestCallback[] = []
  let el: HTMLDivElement

  /** Runs the frame callbacks waiting now, at time `t`. */
  const frame = (t: number) => {
    const due = frames
    frames = []
    for (const cb of due) cb(t)
  }

  beforeEach(() => {
    frames = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      frames = []
    })
    el = document.createElement('div')
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 5000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 })
    el.scrollTop = 0
  })

  afterEach(() => {
    frames = []
  })

  it('glides to the target over several frames instead of jumping, then stops', () => {
    // Arrange
    const { result } = renderHook(() => useDampedFollow({ current: el }))

    // Act
    act(() => result.current.to(1000))

    // Assert: nothing moves before a frame; the first frame moves a little.
    expect(el.scrollTop).toBe(0)
    frame(16)
    expect(el.scrollTop).toBeGreaterThan(0)
    expect(el.scrollTop).toBeLessThan(200)
    for (let t = 32; t <= 600; t += 16) frame(t)
    expect(el.scrollTop).toBe(1000)
    expect(frames).toHaveLength(0)
  })

  it('follows a target that moves on mid-flight without starting over', () => {
    // Arrange
    const { result } = renderHook(() => useDampedFollow({ current: el }))
    act(() => result.current.to(1000))
    frame(16)
    frame(32)
    const mid = el.scrollTop

    // Act
    act(() => result.current.to(1300))
    frame(48)

    // Assert
    expect(el.scrollTop).toBeGreaterThan(mid)
    for (let t = 64; t <= 800; t += 16) frame(t)
    expect(el.scrollTop).toBe(1300)
    expect(window.requestAnimationFrame).toHaveBeenCalled()
  })

  it('stops when the user scrolls, and says so when they scroll back', () => {
    // Arrange
    const onScrollBack = vi.fn()
    const { result } = renderHook(() => useDampedFollow({ current: el }, onScrollBack))
    act(() => result.current.to(1000))
    frame(16)
    frame(32)

    // Act: the user drags the scrollbar up.
    el.scrollTop = 10
    frame(48)

    // Assert
    expect(el.scrollTop).toBe(10)
    expect(onScrollBack).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(0)
  })

  it('carries on from where the browser clamped it when the sheet got shorter', () => {
    // Arrange
    const onScrollBack = vi.fn()
    const { result } = renderHook(() => useDampedFollow({ current: el }, onScrollBack))
    act(() => result.current.to(1000))
    frame(16)

    // Act: the content shrank, and the browser pinned the scroll to its new end.
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 520 })
    el.scrollTop = 20
    frame(32)

    // Assert
    expect(onScrollBack).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)
  })

  it('jumps straight there under reduced motion', () => {
    // Arrange
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    const { result } = renderHook(() => useDampedFollow({ current: el }))

    // Act
    act(() => result.current.to(700))

    // Assert
    expect(el.scrollTop).toBe(700)
    expect(frames).toHaveLength(0)
  })

  it('stop() and unmounting cancel the frame', () => {
    // Arrange
    const { result, unmount } = renderHook(() => useDampedFollow({ current: el }))
    act(() => result.current.to(1000))
    act(() => result.current.stop())
    expect(frames).toHaveLength(0)
    act(() => result.current.to(1000))

    // Act
    unmount()

    // Assert
    expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(2)
    expect(frames).toHaveLength(0)
  })
})
