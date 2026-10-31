// Critique round 4, P1-4: the candidate print is shown aligned, and where the
// aligned photo leaves the frame a blurred, enlarged copy of the same photo
// fills it (extended edges) instead of black wedges.
import { describe, expect, it } from 'vitest'
import type { PhotoDetail, PhotoSummary, Point, Size } from '../../ipc/contract'
import { samples } from '../../ipc/contract.samples'
import { applyAffine, type Affine } from '../../lib/procrustes'
import { coversFrame, FILL_BLEED_PX, fillAffine, fillScale, invertAffine, previewSrc, printSpec } from './print'

const EPS = 1e-6

function rotationAbout(deg: number, c: Point, scale = 1): Affine {
  const r = (deg * Math.PI) / 180
  const a = scale * Math.cos(r)
  const b = scale * Math.sin(r)
  // p' = R·(p − c) + c
  return { a, b, c: -b, d: a, e: c.x - a * c.x + b * c.y, f: c.y - b * c.x - a * c.y }
}

/** Every corner of the frame grown by `bleed` maps back inside the photo under `m` (fill-box space). */
function fillCoversBleed(m: Affine, photo: Size, frame: Size, bleed: number): boolean {
  const inv = invertAffine(m)
  if (!inv) return false
  const w = frame.width + 2 * bleed
  const h = frame.height + 2 * bleed
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: 0, y: h },
    { x: w, y: h },
  ].every((p) => {
    const q = applyAffine(inv, p)
    return q.x >= -EPS && q.y >= -EPS && q.x <= photo.width + EPS && q.y <= photo.height + EPS
  })
}

describe('coversFrame', () => {
  it('is true when the frame sits well inside the photo', () => {
    const shift: Affine = { a: 1, b: 0, c: 0, d: 1, e: -300, f: -300 }
    expect(coversFrame(shift, { width: 1000, height: 1000 }, { width: 400, height: 400 })).toBe(true)
  })

  it('is false when a 7° tilt leaves the corners uncovered', () => {
    const tilt = rotationAbout(7, { x: 200, y: 200 })
    expect(coversFrame(tilt, { width: 400, height: 400 }, { width: 400, height: 400 })).toBe(false)
  })

  it('counts the feathered edge as uncovered', () => {
    // The photo exactly fills the frame: its feathered edges are not solid photo.
    expect(coversFrame({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, { width: 400, height: 400 }, { width: 400, height: 400 })).toBe(false)
  })
})

describe('fillScale and fillAffine', () => {
  const photo = { width: 400, height: 400 }
  const frame = { width: 400, height: 400 }
  const tilt = rotationAbout(7, { x: 200, y: 200 })

  it('enlarges the copy just enough to cover the frame and its bleed', () => {
    const k = fillScale(tilt, photo, frame, FILL_BLEED_PX)
    expect(k).not.toBeNull()
    const scale = k as number
    expect(scale).toBeGreaterThan(1)
    expect(fillCoversBleed(fillAffine(tilt, frame, scale, FILL_BLEED_PX), photo, frame, FILL_BLEED_PX)).toBe(true)
    // …and no more than that.
    expect(fillCoversBleed(fillAffine(tilt, frame, scale * 0.97, FILL_BLEED_PX), photo, frame, FILL_BLEED_PX)).toBe(false)
  })

  it('keeps the frame centre where the sharp print has it, offset by the bleed', () => {
    const k = fillScale(tilt, photo, frame, FILL_BLEED_PX) as number
    const centreInPhoto = applyAffine(invertAffine(tilt) as Affine, { x: 200, y: 200 })
    const p = applyAffine(fillAffine(tilt, frame, k, FILL_BLEED_PX), centreInPhoto)
    expect(p.x).toBeCloseTo(200 + FILL_BLEED_PX, 6)
    expect(p.y).toBeCloseTo(200 + FILL_BLEED_PX, 6)
  })

  it('gives up when the frame centre falls outside the photo', () => {
    const away: Affine = { a: 1, b: 0, c: 0, d: 1, e: -2000, f: 0 }
    expect(fillScale(away, photo, frame, FILL_BLEED_PX)).toBeNull()
  })

  it('gives up on a degenerate transform', () => {
    expect(fillScale({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, photo, frame, FILL_BLEED_PX)).toBeNull()
  })
})

describe('printSpec', () => {
  const photo: PhotoSummary = { ...samples.PhotoSummary, status: 'uncertain' }
  const detail: PhotoDetail = { ...samples.PhotoDetail, summary: photo }
  const refAnchors = samples.ReferenceDetection.anchors
  const frame = { width: 300, height: 400 }
  const base = { photo, detail, detailPending: false, refAnchors, frame, src: 'ftimg://localhost/thumb/x?w=1280&v=1', previewSrc: null }

  it('waits (null) while the detail is still coming, so the unaligned print never flashes', () => {
    expect(printSpec({ ...base, detail: undefined, detailPending: true })).toBeNull()
  })

  it('waits (null) until the frame has a size', () => {
    expect(printSpec({ ...base, frame: null })).toBeNull()
    expect(printSpec({ ...base, frame: { width: 0, height: 0 } })).toBeNull()
  })

  it('aligns the photo to the reference with a CSS matrix', () => {
    const spec = printSpec(base)
    expect(spec?.key).toBe(photo.id)
    expect(spec?.src).toBe(base.src)
    expect(spec?.size).toEqual(photo.size)
    expect(spec?.transform).toMatch(/^matrix\(/)
  })

  it('fills outside a photo that does not cover the frame, and not inside one that does', () => {
    // A 4:3 landscape aligned into a 3:4 frame leaves bands above and below.
    expect(printSpec(base)?.fill).toMatch(/^matrix\(/)
    // A face half as big in the photo is enlarged ×2: the photo then covers the frame.
    const small = refAnchors.map((p) => ({ x: 0.5 + (p.x - 0.5) / 2, y: 0.5 + (p.y - 0.5) / 2 }))
    const tight: PhotoDetail = { ...detail, summary: { ...photo, size: { width: 3000, height: 4000 } }, faces: [{ ...samples.FaceGeometry, anchors: small }] }
    expect(printSpec({ ...base, photo: tight.summary, detail: tight })?.fill).toBeNull()
  })

  it('shows the photo cover-fit when there is nothing to align by', () => {
    const noMatch = { ...detail, matchedFace: null }
    for (const input of [
      { ...base, detail: noMatch },
      { ...base, refAnchors: null },
      { ...base, detail: undefined, detailPending: false },
    ]) {
      const spec = printSpec(input)
      expect(spec?.transform).toBeNull()
      expect(spec?.fill).toBeNull()
    }
  })
})

// Contract v1.7: with a preview version the print is the backend's own aligned frame.
describe('printSpec with a preview', () => {
  const photo: PhotoSummary = { ...samples.PhotoSummary, status: 'uncertain' }
  const detail: PhotoDetail = { ...samples.PhotoDetail, summary: photo }
  const input = { photo, detail, detailPending: false, refAnchors: samples.ReferenceDetection.anchors, frame: { width: 300, height: 400 }, src: 'ftimg://localhost/thumb/x?w=1280&v=1' }

  it('is the preview, cover-fit, with no matrix and no fill', () => {
    const spec = printSpec({ ...input, previewSrc: 'ftimg://localhost/preview/x?w=1280&v=p1' })
    expect(spec).toMatchObject({ kind: 'preview', src: 'ftimg://localhost/preview/x?w=1280&v=p1', transform: null, fill: null })
  })

  it('without one (or once it failed) is the client-side alignment, as before', () => {
    expect(printSpec({ ...input, previewSrc: null })?.kind).toBe('aligned')
  })

  it('builds the preview URL from the detail, bucketed to the route’s widths', () => {
    expect(previewSrc('ftimg://localhost/', photo.id, 'p1', 1)).toBe(`ftimg://localhost/preview/${photo.id}?w=640&v=p1`)
    expect(previewSrc('ftimg://localhost/', photo.id, 'p1', 2)).toBe(`ftimg://localhost/preview/${photo.id}?w=1280&v=p1`)
  })
})

