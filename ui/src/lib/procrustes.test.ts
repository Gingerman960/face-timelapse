import { describe, expect, it } from 'vitest'
import type { Point } from '../ipc/contract'
import {
  IDENTITY_AFFINE,
  IDENTITY_SIMILARITY,
  alignToReference,
  applyAffine,
  similarityToAffine,
  similarityTransform,
  toCssMatrix,
  type Similarity,
} from './procrustes'

const FACE: readonly Point[] = [
  { x: 410.5, y: 520.25 }, { x: 612.75, y: 508.5 }, { x: 515, y: 640.125 }, { x: 440.25, y: 742 }, { x: 590.5, y: 735.75 },
]
const TARGET: readonly Point[] = [
  { x: 380, y: 560 }, { x: 700, y: 560 }, { x: 540, y: 720 }, { x: 420, y: 860 }, { x: 660, y: 860 },
]

/** Applies a similarity to a point set. */
function transform(points: readonly Point[], s: Similarity): Point[] {
  const m = similarityToAffine(s)
  return points.map((p) => applyAffine(m, p))
}

describe('similarityTransform', () => {
  it('recovers known rotation, scale and translation', () => {
    const truth: Similarity = { scale: 1.75, rotation: (12 * Math.PI) / 180, tx: -40, ty: 25.5 }
    const got = similarityTransform(FACE, transform(FACE, truth))
    expect(got.scale).toBeCloseTo(truth.scale, 10)
    expect(got.rotation).toBeCloseTo(truth.rotation, 10)
    expect(got.tx).toBeCloseTo(truth.tx, 8)
    expect(got.ty).toBeCloseTo(truth.ty, 8)
  })

  it('handles negative rotations and pure translation', () => {
    const tilt: Similarity = { scale: 0.5, rotation: -0.6, tx: 3, ty: -7 }
    expect(similarityTransform(FACE, transform(FACE, tilt)).rotation).toBeCloseTo(-0.6, 10)
    const shift = similarityTransform(FACE, transform(FACE, { scale: 1, rotation: 0, tx: 12, ty: -4 }))
    expect(shift.scale).toBeCloseTo(1, 12)
    expect(shift.rotation).toBeCloseTo(0, 12)
    expect(shift.tx).toBeCloseTo(12, 9)
    expect(shift.ty).toBeCloseTo(-4, 9)
  })

  it('matches legacy computeProcrustesTransform bit for bit', () => {
    // Values printed by node from electron/services/alignment.js.
    const m = similarityToAffine(similarityTransform(FACE, TARGET))
    expect(m.a).toBeCloseTo(1.43603887716589, 13)
    expect(m.b).toBeCloseTo(0.045902844768548536, 13)
    expect(m.c).toBeCloseTo(-0.045902844768548536, 13)
    expect(m.d).toBeCloseTo(1.43603887716589, 13)
    expect(m.e).toBeCloseTo(-168.94896730386733, 10)
    expect(m.f).toBeCloseTo(-215.3200480145041, 10)
  })

  it('uses the RMS ratio, not the least-squares scale', () => {
    const src: Point[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }]
    const dst: Point[] = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 0 }]
    // A mirrored set cannot be matched by a rotation; least squares would shrink, the RMS ratio stays 1.
    expect(similarityTransform(src, dst).scale).toBeCloseTo(1, 12)
  })

  it('falls back to identity for degenerate input', () => {
    const two = FACE.slice(0, 2)
    expect(similarityTransform(two, TARGET.slice(0, 2))).toEqual(IDENTITY_SIMILARITY)
    expect(similarityTransform(FACE, TARGET.slice(0, 4))).toEqual(IDENTITY_SIMILARITY)
    const same: Point[] = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }]
    expect(similarityTransform(same, TARGET.slice(0, 3))).toEqual(IDENTITY_SIMILARITY)
    expect(similarityTransform(TARGET.slice(0, 3), same)).toEqual(IDENTITY_SIMILARITY)
    const bad: Point[] = [{ x: Number.NaN, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]
    expect(similarityTransform(bad, TARGET.slice(0, 3))).toEqual(IDENTITY_SIMILARITY)
    expect(similarityTransform(TARGET.slice(0, 3), bad)).toEqual(IDENTITY_SIMILARITY)
    expect(similarityToAffine(IDENTITY_SIMILARITY)).toEqual({ ...IDENTITY_AFFINE, c: -0 })
  })
})

describe('alignToReference', () => {
  it('maps source pixels onto destination anchors', () => {
    const srcSize = { width: 1280, height: 960 }
    const dstSize = { width: 1080, height: 1440 }
    const srcNorm = FACE.map((p) => ({ x: p.x / 1000, y: p.y / 1000 }))
    const truth: Similarity = { scale: 1.3, rotation: 0.1, tx: 50, ty: -20 }
    const dstPx = transform(srcNorm.map((p) => ({ x: p.x * 1280, y: p.y * 960 })), truth)
    const dstNorm = dstPx.map((p) => ({ x: p.x / 1080, y: p.y / 1440 }))
    const m = alignToReference(srcNorm, srcSize, dstNorm, dstSize)
    const mapped = applyAffine(m, { x: srcNorm[0]!.x * 1280, y: srcNorm[0]!.y * 960 })
    expect(mapped.x).toBeCloseTo(dstPx[0]!.x, 8)
    expect(mapped.y).toBeCloseTo(dstPx[0]!.y, 8)
    expect(m.a).toBeCloseTo(1.3 * Math.cos(0.1), 10)
  })

  it('is the identity for identical anchors and sizes', () => {
    const size = { width: 100, height: 100 }
    const pts = TARGET.map((p) => ({ x: p.x / 1000, y: p.y / 1000 }))
    const m = alignToReference(pts, size, pts, size)
    expect(m.a).toBeCloseTo(1, 12)
    expect(m.b).toBeCloseTo(0, 12)
    expect(m.e).toBeCloseTo(0, 9)
  })
})

describe('toCssMatrix', () => {
  it('scales the affine into display space', () => {
    const m = { a: 2, b: 0.5, c: -0.5, d: 2, e: 100, f: -40 }
    expect(toCssMatrix(m, 0.5, 0.25)).toBe('matrix(1, 0.125, -0.25, 0.5, 50, -10)')
  })

  it('prints fixed precision without exponents or negative zero', () => {
    const m = { a: 1e-9, b: -1e-9, c: 1 / 3, d: 1, e: -0, f: 123456.7891234 }
    expect(toCssMatrix(m, 1, 1)).toBe('matrix(0, 0, 0.333333, 1, 0, 123456.789123)')
    expect(toCssMatrix(IDENTITY_AFFINE, 1, 1)).toBe('matrix(1, 0, 0, 1, 0, 0)')
  })
})
