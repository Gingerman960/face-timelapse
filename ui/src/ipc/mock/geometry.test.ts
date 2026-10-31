import { describe, expect, it } from 'vitest'
import {
  IDENTITY,
  adjustAffine,
  applyAffine,
  composeAffine,
  defaultCrop,
  intersect,
  outputSizeFor,
  procrustes,
  rmsDistance,
  rotatedSize,
  roundEven,
} from './geometry'
import { clamp, hashHex, pick, randInt, rngFor, round, shuffled, unitHash } from './random'
import {
  decodeFrameVersion,
  decodeReferenceFrameVersion,
  decodeReferenceImageVersion,
  encodeFrameVersion,
  encodeReferenceFrameVersion,
  encodeReferenceImageVersion,
} from './versions'

describe('outputSizeFor (port of timelapse-video geometry.rs)', () => {
  it.each([
    ['1080p', 4032, 3024, 1440, 1080],
    ['2160p', 4032, 3024, 2880, 2160],
    ['720p', 4032, 3024, 960, 720],
    ['1080p', 3840, 2160, 1920, 1080],
    ['1080p', 2362, 3330, 1080, 1522],
    ['1080p', 3440, 1440, 1920, 804],
    ['1080p', 512, 512, 1080, 1080],
    ['720p', 400, 300, 960, 720],
    ['source', 1080, 1522, 1080, 1522],
    ['source', 511, 383, 510, 382],
    ['source', 2362, 3330, 2160, 3046],
    ['source', 4032, 3024, 2880, 2160],
    ['1080p', 1664, 2219, 1080, 1440],
    ['1080p', 1600, 2000, 1080, 1350],
  ] as const)('%s %ix%i → %ix%i', (res, w, h, ow, oh) => {
    expect(outputSizeFor(res, w, h)).toEqual({ width: ow, height: oh })
  })

  it('rejects empty sources and rounds to even', () => {
    expect(outputSizeFor('source', 0, 10)).toBeNull()
    expect(roundEven(0)).toBe(2)
    expect(roundEven(3)).toBe(4)
    expect(roundEven(1079.4)).toBe(1080)
  })
})

describe('crops and rotation', () => {
  it('builds the largest centred crop of an aspect', () => {
    const size = { width: 3200, height: 2368 }
    expect(defaultCrop(size, 'free')).toEqual({ x: 0, y: 0, ...size })
    expect(defaultCrop(size, '3:4')).toEqual({ x: 712, y: 0, width: 1776, height: 2368 })
    expect(defaultCrop(size, '16:9')).toEqual({ x: 0, y: 284, width: 3200, height: 1800 })
  })

  it('expands the canvas when rotating', () => {
    expect(rotatedSize({ width: 100, height: 50 }, 0)).toEqual({ width: 100, height: 50 })
    expect(rotatedSize({ width: 100, height: 50 }, 90)).toEqual({ width: 50, height: 100 })
  })

  it('intersects rectangles', () => {
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({
      x: 5,
      y: 5,
      width: 5,
      height: 5,
    })
    expect(intersect({ x: 0, y: 0, width: 1, height: 1 }, { x: 5, y: 5, width: 1, height: 1 }).width).toBe(0)
  })
})

describe('affine transforms', () => {
  const src = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 5, y: 8 },
  ]

  it('recovers a similarity transform', () => {
    const truth = { a: 2 * Math.cos(0.3), b: 2 * Math.sin(0.3), c: -2 * Math.sin(0.3), d: 2 * Math.cos(0.3), e: 7, f: -3 }
    const ref = src.map((p) => applyAffine(truth, p))
    const m = procrustes(src, ref)
    expect(rmsDistance(src.map((p) => applyAffine(m, p)), ref)).toBeLessThan(1e-9)
  })

  it('falls back to identity on degenerate input', () => {
    expect(procrustes(src.slice(0, 2), src.slice(0, 2))).toEqual(IDENTITY)
    expect(procrustes(src, src.slice(0, 2))).toEqual(IDENTITY)
    const same = [src[0]!, src[0]!, src[0]!]
    expect(procrustes(same, src)).toEqual(IDENTITY)
    expect(rmsDistance([], [])).toBe(0)
  })

  it('composes adjusts about the output centre', () => {
    const out = { width: 100, height: 200 }
    const centre = { x: 50, y: 100 }
    const rotate = adjustAffine({ dx: 0, dy: 0, scale: 2, rotationDeg: 90 }, out)
    expect(applyAffine(rotate, centre).x).toBeCloseTo(50)
    const shift = adjustAffine({ dx: 0.1, dy: -0.1, scale: 1, rotationDeg: 0 }, out)
    expect(applyAffine(shift, centre)).toEqual({ x: 60, y: 80 })
    const both = composeAffine(shift, rotate)
    expect(applyAffine(both, centre).x).toBeCloseTo(60)
  })
})

describe('random helpers', () => {
  it('are deterministic and bounded', () => {
    expect(hashHex('a', 20)).toMatch(/^[0-9a-f]{20}$/)
    expect(hashHex('a', 8)).toBe(hashHex('a', 8))
    expect(unitHash('x')).toBeLessThan(1)
    const rng = rngFor('seed')
    const n = randInt(rng, 3, 5)
    expect(n >= 3 && n <= 5).toBe(true)
    expect(shuffled([1, 2, 3, 4], rngFor('s')).sort()).toEqual([1, 2, 3, 4])
    expect(() => pick([], rng)).toThrow()
    expect(round(-0.0001, 2)).toBe(0)
    expect(Object.is(round(-0.0001, 2), -0)).toBe(false)
    expect(clamp(5, 0, 1)).toBe(1)
  })
})

describe('version tokens', () => {
  const frame = {
    look: { normalize: 'exposureAndColor' as const, strength: 0.7 },
    adjust: { dx: 0.012, dy: -0.02, scale: 1.04, rotationDeg: -2.5 },
    rotationDeg: -0.4,
    crop: { x: 746, y: 0, width: 1664, height: 2219 },
    resolution: '1080p' as const,
    backdrop: 'blurred' as const,
    variant: 'portrait' as const,
  }

  it('round-trips frame render parameters', () => {
    const v = encodeFrameVersion('seed', frame)
    expect(v).toMatch(/^f[0-9a-f]{45}$/)
    expect(decodeFrameVersion(v)).toEqual(frame)
    expect(encodeFrameVersion('other', frame)).not.toBe(v)
  })

  it('round-trips reference versions', () => {
    const image = { rotationDeg: 12.5, variant: 'noFace' as const }
    expect(decodeReferenceImageVersion(encodeReferenceImageVersion('p', image))).toEqual(image)
    const crop = { rotationDeg: 0, crop: frame.crop, variant: 'portrait' as const }
    expect(decodeReferenceFrameVersion(encodeReferenceFrameVersion('p', crop))).toEqual(crop)
  })

  it('rejects foreign tokens', () => {
    for (const bad of ['', 'abc', 'f'.repeat(46), 'z'.repeat(46), '0123abcd']) {
      expect(decodeFrameVersion(bad)).toBeNull()
      expect(decodeReferenceFrameVersion(bad)).toBeNull()
      expect(decodeReferenceImageVersion(bad)).toBeNull()
    }
    const v = encodeFrameVersion('seed', frame)
    expect(decodeFrameVersion(`${v.slice(0, 9)}f${v.slice(10)}`)).toBeNull()
    const ref = encodeReferenceImageVersion('p', { rotationDeg: 0, variant: 'portrait' })
    expect(decodeReferenceImageVersion(`${ref.slice(0, -1)}f`)).toBeNull()
    const refFrame = encodeReferenceFrameVersion('p', { rotationDeg: 0, crop: frame.crop, variant: 'portrait' })
    expect(decodeReferenceFrameVersion(`${refFrame.slice(0, -1)}f`)).toBeNull()
  })
})
