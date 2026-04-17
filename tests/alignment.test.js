import { describe, it, expect } from 'vitest'
import { computeProcrustesTransform, scalePoints } from '../electron/services/alignment.js'

describe('computeProcrustesTransform', () => {
  it('returns identity-like transform when src equals ref', () => {
    const pts = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 150, y: 200 },
      { x: 120, y: 250 },
      { x: 180, y: 250 },
    ]
    const t = computeProcrustesTransform(pts, pts)
    expect(t.a).toBeCloseTo(1, 5)
    expect(t.b).toBeCloseTo(0, 5)
    expect(t.c).toBeCloseTo(0, 5)
    expect(t.d).toBeCloseTo(1, 5)
    expect(t.tx).toBeCloseTo(0, 5)
    expect(t.ty).toBeCloseTo(0, 5)
  })

  it('recovers a pure translation', () => {
    const src = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ]
    const ref = src.map((p) => ({ x: p.x + 50, y: p.y - 30 }))
    const t = computeProcrustesTransform(src, ref)
    expect(t.a).toBeCloseTo(1, 5)
    expect(t.d).toBeCloseTo(1, 5)
    expect(t.tx).toBeCloseTo(50, 3)
    expect(t.ty).toBeCloseTo(-30, 3)
  })

  it('recovers a uniform scale', () => {
    const src = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ]
    const ref = src.map((p) => ({ x: p.x * 2, y: p.y * 2 }))
    const t = computeProcrustesTransform(src, ref)
    const scale = Math.hypot(t.a, t.b)
    expect(scale).toBeCloseTo(2, 3)
  })

  it('returns fallback identity when inputs are degenerate', () => {
    const tooFew = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
    const t = computeProcrustesTransform(tooFew, tooFew)
    expect(t).toEqual({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })
  })

  it('returns fallback identity when lengths mismatch', () => {
    const a = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]
    const b = [{ x: 0, y: 0 }, { x: 1, y: 0 }]
    const t = computeProcrustesTransform(a, b)
    expect(t).toEqual({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })
  })

  it('returns fallback identity when src points are all identical (zero variance)', () => {
    const src = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }]
    const ref = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }]
    const t = computeProcrustesTransform(src, ref)
    expect(t).toEqual({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })
  })
})

describe('scalePoints', () => {
  it('scales proportionally when aspect ratio is preserved', () => {
    const pts = [{ x: 100, y: 50 }, { x: 200, y: 100 }]
    const result = scalePoints(pts, { w: 400, h: 200 }, { w: 800, h: 400 })
    expect(result).toEqual([
      { x: 200, y: 100 },
      { x: 400, y: 200 },
    ])
  })

  it('applies independent x and y scaling', () => {
    const pts = [{ x: 100, y: 100 }]
    const result = scalePoints(pts, { w: 200, h: 200 }, { w: 400, h: 100 })
    expect(result[0].x).toBeCloseTo(200)
    expect(result[0].y).toBeCloseTo(50)
  })

  it('returns empty array for empty input', () => {
    expect(scalePoints([], { w: 100, h: 100 }, { w: 200, h: 200 })).toEqual([])
  })
})
