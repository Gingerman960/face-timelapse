import { describe, expect, it } from 'vitest'
import type { AspectPreset, Rect, Size } from '../ipc/contract'
import {
  ASPECT_PRESETS,
  MIN_CROP_SIZE,
  aspectRatioOf,
  centerFaceCrop,
  clampCrop,
  cropMatchesAspect,
  defaultCrop,
  isFullImage,
  isNudgeKey,
  moveCrop,
  nudgeCrop,
  reshapeToAspect,
  resizeCrop,
  type CropHandle,
} from './crop'

const LAND: Size = { width: 4032, height: 3024 }
const PORT: Size = { width: 3024, height: 4032 }
const HANDLES: readonly CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** Asserts the documented invariants of every crop result. */
function expectValid(crop: Rect, size: Size, aspect: AspectPreset): void {
  for (const v of [crop.x, crop.y, crop.width, crop.height]) expect(Number.isInteger(v)).toBe(true)
  expect(crop.x).toBeGreaterThanOrEqual(0)
  expect(crop.y).toBeGreaterThanOrEqual(0)
  expect(crop.x + crop.width).toBeLessThanOrEqual(size.width)
  expect(crop.y + crop.height).toBeLessThanOrEqual(size.height)
  expect(Math.min(crop.width, crop.height)).toBeGreaterThanOrEqual(MIN_CROP_SIZE)
  expect(cropMatchesAspect(crop, aspect)).toBe(true)
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('presets and defaults', () => {
  it('maps presets to ratios', () => {
    expect(aspectRatioOf('free')).toBeNull()
    expect(aspectRatioOf('16:9')).toBeCloseTo(16 / 9, 12)
    expect(aspectRatioOf('4:5')).toBe(0.8)
    expect(ASPECT_PRESETS).toHaveLength(7)
  })

  it('defaults to the largest centred crop', () => {
    expect(defaultCrop(LAND, 'free')).toEqual({ x: 0, y: 0, width: 4032, height: 3024 })
    expect(defaultCrop(LAND, '1:1')).toEqual({ x: 504, y: 0, width: 3024, height: 3024 })
    expect(defaultCrop(LAND, '16:9')).toEqual({ x: 0, y: 378, width: 4032, height: 2268 })
    expect(defaultCrop(LAND, '9:16')).toEqual({ x: 1166, y: 0, width: 1701, height: 3024 })
    expect(defaultCrop(LAND, '4:5')).toEqual({ x: 807, y: 0, width: 2419, height: 3024 })
    expect(defaultCrop(PORT, '3:4')).toEqual({ x: 0, y: 0, width: 3024, height: 4032 })
    for (const aspect of ASPECT_PRESETS) expectValid(defaultCrop(LAND, aspect), LAND, aspect)
  })

  it('does its best on images too small for a valid crop', () => {
    // 30 px wide cannot hold a 32 px side; 30:37.5 has no integer fit within tolerance.
    expect(defaultCrop({ width: 30, height: 100 }, '4:5')).toEqual({ x: 0, y: 31, width: 30, height: 38 })
  })

  it('reshapes around the current centre', () => {
    const crop = { x: 1500, y: 1000, width: 1000, height: 1000 }
    expect(reshapeToAspect(crop, LAND, '16:9')).toEqual({ x: 0, y: 366, width: 4032, height: 2268 })
    expect(reshapeToAspect(crop, LAND, '9:16')).toEqual({ x: 1150, y: 0, width: 1701, height: 3024 })
    expect(reshapeToAspect(crop, LAND, 'free')).toEqual({ x: 0, y: 0, width: 4032, height: 3024 })
  })
})

describe('clampCrop', () => {
  it('keeps the aspect at the borders (legacy B31 fix)', () => {
    const tooTall = { x: 1000, y: -200, width: 2000, height: 3556 }
    const fixed = clampCrop(tooTall, LAND, '9:16')
    expect(fixed).toEqual({ x: 1150, y: 0, width: 1701, height: 3024 })
    expectValid(fixed, LAND, '9:16')
    expect(clampCrop({ x: 3000, y: 10, width: 2000, height: 1125 }, LAND, '16:9')).toEqual({
      x: 2032, y: 10, width: 2000, height: 1125,
    })
  })

  it('grows tiny crops to the minimum and fits huge ones', () => {
    expectValid(clampCrop({ x: 10, y: 10, width: 5, height: 5 }, LAND, '4:3'), LAND, '4:3')
    expect(clampCrop({ x: 10, y: 10, width: 5, height: 5 }, LAND, 'free')).toEqual({ x: 0, y: 0, width: 32, height: 32 })
    expect(clampCrop({ x: -50, y: -50, width: 9000, height: 9000 }, LAND, 'free')).toEqual({ x: 0, y: 0, width: 4032, height: 3024 })
    expect(clampCrop({ x: 4000.4, y: 2.6, width: 100.2, height: 80.7 }, LAND, 'free')).toEqual({ x: 3932, y: 2, width: 100, height: 81 })
  })

  it('is idempotent', () => {
    for (const aspect of ASPECT_PRESETS) {
      const once = clampCrop({ x: 123.7, y: 45.2, width: 777.3, height: 555.5 }, LAND, aspect)
      expect(clampCrop(once, LAND, aspect)).toEqual(once)
    }
  })
})

describe('move and nudge', () => {
  it('moves by rounded deltas and stops at the borders', () => {
    const crop = { x: 100, y: 100, width: 500, height: 400 }
    expect(moveCrop(crop, 10.4, -3.6, LAND)).toEqual({ x: 110, y: 96, width: 500, height: 400 })
    expect(moveCrop(crop, -500, 99999, LAND)).toEqual({ x: 0, y: 2624, width: 500, height: 400 })
    expect(moveCrop(crop, Number.NaN, 5, LAND)).toEqual({ x: 100, y: 105, width: 500, height: 400 })
  })

  it('nudges 1 px or 10 px with shift', () => {
    const crop = { x: 5, y: 5, width: 100, height: 100 }
    expect(nudgeCrop(crop, 'ArrowRight', false, LAND).x).toBe(6)
    expect(nudgeCrop(crop, 'ArrowDown', true, LAND).y).toBe(15)
    expect(nudgeCrop(crop, 'ArrowLeft', true, LAND).x).toBe(0)
    expect(nudgeCrop(crop, 'ArrowUp', false, LAND).y).toBe(4)
    expect(isNudgeKey('ArrowUp')).toBe(true)
    expect(isNudgeKey('KeyL')).toBe(false)
    expect(isNudgeKey('toString')).toBe(false)
  })
})

describe('resizeCrop', () => {
  const box = { x: 1000, y: 800, width: 1600, height: 900 }

  it('moves free edges independently with a minimum', () => {
    expect(resizeCrop(box, 'se', 100, 50, LAND, 'free')).toEqual({ x: 1000, y: 800, width: 1700, height: 950 })
    expect(resizeCrop(box, 'nw', 2000, 2000, LAND, 'free')).toEqual({ x: 2568, y: 1668, width: 32, height: 32 })
    expect(resizeCrop(box, 'w', -5000, 0, LAND, 'free')).toEqual({ x: 0, y: 800, width: 2600, height: 900 })
    expect(resizeCrop(box, 'n', 0, -10.6, LAND, 'free')).toEqual({ x: 1000, y: 789, width: 1600, height: 911 })
    expect(resizeCrop(box, 'e', 9999, 0, LAND, 'free', 64).width).toBe(3032)
  })

  it('keeps the other axis centred on locked edges', () => {
    const e = resizeCrop(box, 'e', 160, 0, LAND, '16:9')
    expect(e).toEqual({ x: 1000, y: 755, width: 1760, height: 990 })
    const s = resizeCrop(box, 's', 0, 90, LAND, '16:9')
    expect(s).toEqual({ x: 920, y: 800, width: 1760, height: 990 })
    const w = resizeCrop(box, 'w', 160, 0, LAND, '16:9')
    expect(w).toEqual({ x: 1160, y: 845, width: 1440, height: 810 })
  })

  it('anchors locked corners at the opposite corner', () => {
    expect(resizeCrop(box, 'se', 160, 0, LAND, '16:9')).toEqual({ x: 1000, y: 800, width: 1760, height: 990 })
    expect(resizeCrop(box, 'nw', -160, 0, LAND, '16:9')).toEqual({ x: 840, y: 710, width: 1760, height: 990 })
    // A vertical drag on a corner drives the size too (dominant axis).
    expect(resizeCrop(box, 'sw', 0, 90, LAND, '16:9')).toEqual({ x: 840, y: 800, width: 1760, height: 990 })
  })

  it('stops at the image border without losing the aspect', () => {
    const se = resizeCrop(box, 'se', 9999, 9999, LAND, '16:9')
    expect(se).toEqual({ x: 1000, y: 800, width: 3031, height: 1705 })
    expectValid(se, LAND, '16:9')
    const n = resizeCrop(box, 'n', 0, -9999, LAND, '16:9')
    expectValid(n, LAND, '16:9')
    expect(n.y + n.height).toBe(box.y + box.height)
    const shrink = resizeCrop(box, 'ne', -9999, 0, LAND, '4:3')
    expectValid(shrink, LAND, '4:3')
    expect(shrink).toEqual({ x: 1000, y: 1667, width: 44, height: 33 })
  })

  it('preserves every invariant over random edits', () => {
    const next = rng(42)
    const sizes: readonly Size[] = [LAND, PORT, { width: 1080, height: 1920 }, { width: 640, height: 480 }, { width: 100, height: 80 }]
    for (const size of sizes) {
      for (const aspect of ASPECT_PRESETS) {
        let crop = defaultCrop(size, aspect)
        for (let i = 0; i < 60; i++) {
          const op = Math.floor(next() * 4)
          const dx = (next() - 0.5) * size.width
          const dy = (next() - 0.5) * size.height
          const handle = HANDLES[Math.floor(next() * HANDLES.length)] ?? 'se'
          if (op === 0) crop = resizeCrop(crop, handle, dx, dy, size, aspect)
          else if (op === 1) crop = moveCrop(crop, dx, dy, size)
          else if (op === 2) crop = centerFaceCrop(crop, { x: next(), y: next(), width: 0.1, height: 0.1 }, size, aspect)
          else crop = clampCrop({ ...crop, width: crop.width + dx }, size, aspect)
          expectValid(crop, size, aspect)
        }
      }
    }
  })
})

describe('centerFaceCrop', () => {
  const face = { x: 0.45, y: 0.4, width: 0.1, height: 0.2 }

  it('keeps the size when the face can be centred', () => {
    const crop = { x: 0, y: 0, width: 1600, height: 900 }
    expect(centerFaceCrop(crop, face, LAND, '16:9')).toEqual({ x: 1216, y: 1062, width: 1600, height: 900 })
  })

  it('shrinks with the aspect when the face is near a border', () => {
    const nearLeft = { x: 0.05, y: 0.45, width: 0.1, height: 0.1 }
    const got = centerFaceCrop({ x: 0, y: 0, width: 1600, height: 900 }, nearLeft, LAND, '16:9')
    expect(got.width).toBeLessThanOrEqual(807)
    expect(got.x + got.width / 2).toBeCloseTo(403.2, 0)
    expectValid(got, LAND, '16:9')
  })

  it('handles free crops and bad input', () => {
    const nearTop = { x: 0.4, y: 0, width: 0.2, height: 0.02 }
    const crop = { x: 0, y: 0, width: 1000, height: 1000 }
    expect(centerFaceCrop(crop, nearTop, LAND, 'free')).toEqual({ x: 1516, y: 0, width: 1000, height: 60 })
    expect(centerFaceCrop(crop, { ...face, x: Number.NaN }, LAND, '1:1')).toBe(crop)
  })
})

describe('validation helpers', () => {
  it('detects the full image within 1 px', () => {
    expect(isFullImage({ x: 0, y: 0, width: 4032, height: 3024 }, LAND)).toBe(true)
    expect(isFullImage({ x: 1, y: 0, width: 4031, height: 3023 }, LAND)).toBe(true)
    expect(isFullImage({ x: 0, y: 0, width: 4000, height: 3024 }, LAND)).toBe(false)
  })

  it('checks the aspect within 1 %', () => {
    expect(cropMatchesAspect({ x: 0, y: 0, width: 1920, height: 1080 }, '16:9')).toBe(true)
    expect(cropMatchesAspect({ x: 0, y: 0, width: 1935, height: 1080 }, '16:9')).toBe(true)
    expect(cropMatchesAspect({ x: 0, y: 0, width: 1950, height: 1080 }, '16:9')).toBe(false)
    expect(cropMatchesAspect({ x: 0, y: 0, width: 10, height: 999 }, 'free')).toBe(true)
    expect(cropMatchesAspect({ x: 0, y: 0, width: 0, height: 10 }, 'free')).toBe(false)
  })
})
