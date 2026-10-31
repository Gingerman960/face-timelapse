// The candidate print. With contract v1.7 it is the backend's own preview of
// the aligned frame the photo would get now (extended edges, its nudge and
// all); without one (no reference face, no matched face) or when the preview
// can't be had, the unsure photo is aligned here instead (a CSS matrix on its
// thumbnail) over a blurred extended-edge fill (critique round 4, P1-4).
import type { PhotoDetail, PhotoId, PhotoSummary, Point, Size, Version } from '../../ipc/contract'
import { previewUrl, thumbUrl, type ThumbRef } from '../../ipc/images'
import { alignToReference, applyAffine, toCssMatrix, type Affine } from '../../lib/procrustes'

/** The print asks the thumb route for about this CSS width (× device pixels, then bucketed). */
export const PRINT_CSS_WIDTH = 1100
/** The preview's CSS width: the candidate frame is at most about this wide (× device pixels: 640 or 1280). */
export const PREVIEW_CSS_WIDTH = 640
/** The sharp print's feathered edge, as a fraction of each side (`--feather` in review.css). */
export const FEATHER = 0.03
/**
 * How far the blurred fill reaches past the frame on every side, in CSS px.
 * The blur (half of this) fades to transparent at the fill's own edge; the
 * bleed keeps that fade outside the frame, which clips it.
 */
export const FILL_BLEED_PX = 56
/** Past this enlargement the fill is only a colour wash; leave the sunken well instead. */
const MAX_FILL_SCALE = 8

/** How a print is drawn: the backend's preview, aligned here (matrix), or the photo as it is. */
export type PrintKind = 'preview' | 'aligned' | 'plain'

/** One print on the light table: everything needed to draw a photo in the candidate frame. */
export interface PrintSpec {
  /** The photo's id: one print per photo. */
  key: string
  kind: PrintKind
  src: string
  /** The photo's pixel size: the `<img>` is laid out at this size, then transformed. */
  size: Size
  /** CSS matrix aligning the photo to the reference; null shows it cover-fit (nothing to align by). */
  transform: string | null
  /** CSS matrix of the blurred, enlarged copy behind it (fill-box space); null when none is needed. */
  fill: string | null
}

export interface PrintInput {
  photo: PhotoSummary
  detail: PhotoDetail | undefined
  /** True while the detail is still on its way: the print waits rather than flash the unaligned photo. */
  detailPending: boolean
  /** Reference anchors, normalized to the output frame. */
  refAnchors: Point[] | null
  /** The frame's CSS size; null until it has been measured. */
  frame: Size | null
  src: string
  /** The preview to show (v1.7), or null: none for this photo, or it couldn't be had. */
  previewSrc: string | null
}

/** The thumbnail the print shows (the same URL is prefetched and decoded ahead). */
export function printSrc(base: string, photo: ThumbRef, dpr: number): string {
  return thumbUrl(base, photo, PRINT_CSS_WIDTH, dpr)
}

/** The preview route's URL for a photo (contract v1.7), bucketed to the candidate frame. */
export function previewSrc(base: string, photoId: PhotoId, version: Version, dpr: number): string {
  return previewUrl(base, photoId, version, PREVIEW_CSS_WIDTH, dpr)
}

/** What the print for `photo` loads: its preview when the detail has one, else its thumbnail. */
export function printSource(base: string, photo: PhotoSummary, detail: PhotoDetail | undefined, dpr: number): string {
  return detail?.previewVersion ? previewSrc(base, photo.id, detail.previewVersion, dpr) : printSrc(base, photo, dpr)
}

/** Inverse of an affine, or null when it is degenerate. */
export function invertAffine(m: Affine): Affine | null {
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const a = m.d / det
  const b = -m.b / det
  const c = -m.c / det
  const d = m.a / det
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) }
}

/** `outer ∘ inner`: apply `inner` first. */
function compose(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  }
}

function corners(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x0, y: y1 },
    { x: x1, y: y1 },
  ]
}

/** True when the photo's solid (unfeathered) area covers the whole frame under `affine`. */
export function coversFrame(affine: Affine, photo: Size, frame: Size, feather = FEATHER): boolean {
  const inv = invertAffine(affine)
  if (!inv) return false
  const fx = photo.width * feather
  const fy = photo.height * feather
  return corners(0, 0, frame.width, frame.height).every((p) => {
    const q = applyAffine(inv, p)
    return q.x >= fx && q.x <= photo.width - fx && q.y >= fy && q.y <= photo.height - fy
  })
}

/** Smallest k on one axis keeping `q + u / k` inside [0, extent]; null when no k can. */
function axisScale(q: number, u: number, extent: number): number | null {
  if (q < 0 || q > extent) return null
  if (u > 0) return extent - q > 0 ? u / (extent - q) : null
  if (u < 0) return q > 0 ? -u / q : null
  return 0
}

/**
 * The enlargement (about the frame centre) at which the aligned photo covers
 * the frame grown by `bleed` on every side: at least 1, so the fill also sits
 * under the feathered edges. Null when no enlargement can (the frame centre
 * lies outside the photo, or the transform is degenerate).
 */
export function fillScale(affine: Affine, photo: Size, frame: Size, bleed = FILL_BLEED_PX): number | null {
  const inv = invertAffine(affine)
  if (!inv) return null
  const centre = { x: frame.width / 2, y: frame.height / 2 }
  const q = applyAffine(inv, centre)
  let k = 1
  for (const p of corners(-bleed, -bleed, frame.width + bleed, frame.height + bleed)) {
    // The corner's offset from the centre, in photo pixels.
    const v = { x: p.x - centre.x, y: p.y - centre.y }
    const u = { x: inv.a * v.x + inv.c * v.y, y: inv.b * v.x + inv.d * v.y }
    const kx = axisScale(q.x, u.x, photo.width)
    const ky = axisScale(q.y, u.y, photo.height)
    if (kx === null || ky === null) return null
    k = Math.max(k, kx, ky)
  }
  return k <= MAX_FILL_SCALE ? k : null
}

/** The fill's affine in fill-box space: the aligned photo, enlarged by `k` about the frame centre, shifted by the bleed. */
export function fillAffine(affine: Affine, frame: Size, k: number, bleed = FILL_BLEED_PX): Affine {
  const cx = frame.width / 2
  const cy = frame.height / 2
  const aroundCentre: Affine = { a: k, b: 0, c: 0, d: k, e: cx - k * cx + bleed, f: cy - k * cy + bleed }
  return compose(aroundCentre, affine)
}

/**
 * The print for `photo` in a frame of `frame` CSS px, or null while it can't
 * be drawn yet (frame unmeasured, or the detail still coming). With nothing to
 * align by (no matched face, no reference anchors, the detail failed) it is
 * the photo cover-fit, with no fill.
 */
export function printSpec({ photo, detail, detailPending, refAnchors, frame, src, previewSrc: preview }: PrintInput): PrintSpec | null {
  if (!frame || frame.width <= 0 || frame.height <= 0) return null
  if (!detail && detailPending) return null
  if (preview) return { key: photo.id, kind: 'preview', src: preview, size: photo.size, transform: null, fill: null }
  const plain: PrintSpec = { key: photo.id, kind: 'plain', src, size: photo.size, transform: null, fill: null }
  const face = detail && detail.matchedFace !== null ? detail.faces[detail.matchedFace] : undefined
  if (!face || !refAnchors) return plain
  const affine = alignToReference(face.anchors, photo.size, refAnchors, frame)
  const k = coversFrame(affine, photo.size, frame) ? null : fillScale(affine, photo.size, frame)
  return {
    ...plain,
    kind: 'aligned',
    transform: toCssMatrix(affine, 1, 1),
    fill: k === null ? null : toCssMatrix(fillAffine(affine, frame, k), 1, 1),
  }
}
