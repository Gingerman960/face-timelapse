import { describe, it, expect } from 'vitest'
import {
  generateEmbedding,
  compareFaces,
  categorize,
  THRESHOLDS,
} from '../electron/services/faceEmbedding.js'

function makeSynthetic68(scale = 1) {
  // Fabricate a plausible 68-point landmark layout on a synthetic face.
  // Exact positions don't matter for structural tests; what matters is that
  // every slice the embedding reads has enough points with non-zero spread.
  const pts = []
  for (let i = 0; i < 17; i++) pts.push({ x: (i - 8) * 10 * scale, y: 80 * scale })      // contour
  for (let i = 0; i < 5; i++) pts.push({ x: (-30 + i * 10) * scale, y: -10 * scale })    // leftEyebrow
  for (let i = 0; i < 5; i++) pts.push({ x: (10 + i * 10) * scale, y: -10 * scale })     // rightEyebrow
  for (let i = 0; i < 4; i++) pts.push({ x: 0, y: (0 + i * 5) * scale })                 // noseBridge
  for (let i = 0; i < 5; i++) pts.push({ x: (-10 + i * 5) * scale, y: 25 * scale })      // noseBase
  for (let i = 0; i < 6; i++) pts.push({ x: (-30 + i * 4) * scale, y: 0 * scale })       // leftEye
  for (let i = 0; i < 6; i++) pts.push({ x: (10 + i * 4) * scale, y: 0 * scale })        // rightEye
  for (let i = 0; i < 12; i++) pts.push({ x: (-15 + i * 2.5) * scale, y: 45 * scale })   // outerLips
  for (let i = 0; i < 8; i++) pts.push({ x: (-10 + i * 2.5) * scale, y: 48 * scale })    // innerLips
  return pts
}

describe('generateEmbedding', () => {
  it('returns exactly 45 features', () => {
    const lm = makeSynthetic68(1)
    const emb = generateEmbedding(lm)
    expect(emb).toHaveLength(45)
  })

  it('returns finite numbers across all features', () => {
    const lm = makeSynthetic68(1)
    const emb = generateEmbedding(lm)
    for (const v of emb) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('is scale-invariant: embedding is (nearly) the same at 1x and 2x', () => {
    const a = generateEmbedding(makeSynthetic68(1))
    const b = generateEmbedding(makeSynthetic68(2))
    // Geometric ratios should match within floating-point tolerance
    for (let i = 0; i < a.length; i++) {
      expect(b[i]).toBeCloseTo(a[i], 5)
    }
  })
})

describe('compareFaces', () => {
  it('returns 1 when comparing identical embeddings', () => {
    const emb = generateEmbedding(makeSynthetic68(1))
    expect(compareFaces(emb, emb)).toBeCloseTo(1, 6)
  })

  it('returns 0 for mismatched lengths', () => {
    expect(compareFaces([1, 2, 3], [1, 2])).toBe(0)
  })

  it('returns 0 for null inputs', () => {
    expect(compareFaces(null, [1, 2, 3])).toBe(0)
    expect(compareFaces([1, 2, 3], null)).toBe(0)
  })

  it('decreases monotonically as distance increases', () => {
    const a = [0, 0, 0]
    const b = [1, 0, 0]
    const c = [2, 0, 0]
    expect(compareFaces(a, b)).toBeGreaterThan(compareFaces(a, c))
  })
})

describe('categorize', () => {
  it('confirms at or above the confirmed threshold', () => {
    expect(categorize(THRESHOLDS.confirmed)).toBe('confirmed')
    expect(categorize(THRESHOLDS.confirmed + 0.1)).toBe('confirmed')
  })

  it('marks uncertain between thresholds', () => {
    const mid = (THRESHOLDS.uncertain + THRESHOLDS.confirmed) / 2
    expect(categorize(mid)).toBe('uncertain')
    expect(categorize(THRESHOLDS.uncertain)).toBe('uncertain')
  })

  it('rejects below the uncertain threshold', () => {
    expect(categorize(THRESHOLDS.uncertain - 0.01)).toBe('rejected')
    expect(categorize(0)).toBe('rejected')
  })
})
