import { describe, expect, it } from 'vitest'
import { crossfadePlan, type PlanFrame } from '../../lib/video'
import { MAX_TICK_MS, advance, outputOf, photoAt, playerPatch, stillOf, type TickInput } from './playback'

const always = () => true

function input(overrides: Partial<TickInput> = {}): TickInput {
  return { plan: crossfadePlan(5, 0, 'linear'), fps: 10, rate: 1, loop: true, canShow: always, ...overrides }
}

describe('advance', () => {
  it('moves one output frame per 1/fps and keeps the remainder', () => {
    // Act
    const r = advance({ out: 0, acc: 0 }, 250, input())

    // Assert
    expect(r.out).toBe(2)
    expect(r.acc).toBeCloseTo(0.5, 9)
    expect(r.ended).toBe(false)
  })

  it('scales with the shuttle rate and plays backwards', () => {
    expect(advance({ out: 0, acc: 0 }, 100, input({ rate: 2 })).out).toBe(2)
    expect(advance({ out: 4, acc: 0 }, 100, input({ rate: -1 })).out).toBe(3)
  })

  it('wraps at either end when looping and stops when not', () => {
    expect(advance({ out: 4, acc: 0 }, 100, input()).out).toBe(0)
    expect(advance({ out: 0, acc: 0 }, 100, input({ rate: -1 })).out).toBe(4)
    expect(advance({ out: 4, acc: 0.5 }, 100, input({ loop: false }))).toEqual({ out: 4, acc: 0, ended: true })
  })

  it('holds (never skips) while the next frame cannot be shown', () => {
    // Arrange
    const blocked = (f: PlanFrame) => f.a !== 2

    // Act
    const held = advance({ out: 1, acc: 0 }, 200, input({ canShow: blocked }))
    const resumed = advance(held, 0, input())

    // Assert
    expect(held).toEqual({ out: 1, acc: 1, ended: false })
    expect(resumed.out).toBe(2)
  })

  it('shows a held frame as soon as it decodes and does not catch up the wait', () => {
    // Act: held for a while, then 100 ms (one frame at 10 fps) later the frame is there.
    const resumed = advance({ out: 1, acc: 1 }, 100, input())

    // Assert: one step, and the next one is a full frame away.
    expect(resumed).toEqual({ out: 2, acc: 0, ended: false })
  })

  it('needs both photos of a blend frame', () => {
    // Arrange: 2 photos with 1 blend frame between them.
    const plan = crossfadePlan(2, 1, 'linear')
    const onlyFirst = (f: PlanFrame) => f.a === 0 && f.b === null

    // Act + Assert
    expect(advance({ out: 0, acc: 0 }, 100, input({ plan, canShow: onlyFirst })).out).toBe(0)
    expect(advance({ out: 0, acc: 0 }, 100, input({ plan })).out).toBe(1)
  })

  it('catches up at most MAX_TICK_MS and ignores negative gaps', () => {
    expect(advance({ out: 0, acc: 0 }, 10_000, input({ plan: crossfadePlan(100, 0, 'linear') })).out).toBe(Math.floor((MAX_TICK_MS / 1000) * 10))
    expect(advance({ out: 3, acc: 0.25 }, -50, input())).toEqual({ out: 3, acc: 0.25, ended: false })
  })

  it('an empty timeline has nothing to play', () => {
    expect(advance({ out: 3, acc: 0 }, 100, input({ plan: crossfadePlan(0, 0, 'linear') }))).toEqual({ out: 0, acc: 0, ended: true })
  })
})

describe('plan addressing', () => {
  it('maps output frames to photos and back, holds and blends included', () => {
    // Arrange: 3 photos, 1 blend frame each, 2 first-hold and 1 last-hold frames.
    const plan = crossfadePlan(3, 1, 'linear', { first: 2, last: 1 })

    // Act + Assert
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((o) => photoAt(plan, o))).toEqual([0, 0, 0, 0, 1, 1, 2, 2])
    expect(photoAt(plan, 99)).toBe(0)
    expect(outputOf(plan, 0)).toBe(2)
    expect(outputOf(plan, 2)).toBe(6)
    expect(outputOf(plan, 40)).toBe(6)
    expect(outputOf(plan, -3)).toBe(2)
    expect(outputOf(crossfadePlan(0, 0, 'linear'), 4)).toBe(0)
    expect(stillOf(7)).toEqual({ a: 7, b: null, t: 0 })
  })
})

describe('playerPatch', () => {
  it('writes the photo every change and the settled index only when due', () => {
    expect(playerPatch({ index: 3, settled: 0 }, 4, false)).toEqual({ index: 4 })
    expect(playerPatch({ index: 3, settled: 0 }, 4, true)).toEqual({ index: 4, settled: 4 })
    expect(playerPatch({ index: 4, settled: 0 }, 4, true)).toEqual({ settled: 4 })
    expect(playerPatch({ index: 4, settled: 4 }, 4, true)).toBeNull()
    expect(playerPatch({ index: 4, settled: 1 }, 4, false)).toBeNull()
  })
})
