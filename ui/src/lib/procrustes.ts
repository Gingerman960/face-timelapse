// ui/src/lib/procrustes.ts
// Legacy similarity Procrustes (electron/services/alignment.js, LEGACY-SPEC §4.10),
// operation for operation, plus helpers to show a photo aligned to the reference.
import type { Point, Size } from '../ipc/contract'

/** Similarity mapping src → dst: p' = scale · R(rotation) · p + (tx, ty). Rotation in radians. */
export interface Similarity {
  readonly scale: number
  readonly rotation: number
  readonly tx: number
  readonly ty: number
}

/** 2D affine in canvas/CSS order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Affine {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly e: number
  readonly f: number
}

export const IDENTITY_SIMILARITY: Similarity = { scale: 1, rotation: 0, tx: 0, ty: 0 }
export const IDENTITY_AFFINE: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

const MIN_POINTS = 3
const CSS_DECIMALS = 6

/** Mean of a point set (legacy reduce-then-divide order). */
function centroid(points: readonly Point[]): Point {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
  return { x: sum.x / points.length, y: sum.y / points.length }
}

/** RMS distance from the origin. */
function rms(points: readonly Point[]): number {
  const sumSq = points.reduce((acc, p) => acc + p.x * p.x + p.y * p.y, 0)
  return Math.sqrt(sumSq / points.length)
}

/** True when every coordinate is a finite number. */
function allFinite(points: readonly Point[]): boolean {
  return points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
}

/** Legacy Procrustes src → dst: centroids, RMS-ratio scale, atan2(H10−H01, H00+H11); identity if degenerate. */
export function similarityTransform(src: readonly Point[], dst: readonly Point[]): Similarity {
  if (src.length !== dst.length || src.length < MIN_POINTS) return IDENTITY_SIMILARITY
  if (!allFinite(src) || !allFinite(dst)) return IDENTITY_SIMILARITY
  const sc = centroid(src)
  const dc = centroid(dst)
  const srcCentered = src.map((p) => ({ x: p.x - sc.x, y: p.y - sc.y }))
  const dstCentered = dst.map((p) => ({ x: p.x - dc.x, y: p.y - dc.y }))
  const srcStd = rms(srcCentered)
  const dstStd = rms(dstCentered)
  if (srcStd === 0 || dstStd === 0) return IDENTITY_SIMILARITY
  const scale = dstStd / srcStd
  let h00 = 0
  let h01 = 0
  let h10 = 0
  let h11 = 0
  srcCentered.forEach((s, i) => {
    const r = dstCentered[i] ?? { x: 0, y: 0 }
    const sx = s.x / srcStd
    const sy = s.y / srcStd
    const rx = r.x / dstStd
    const ry = r.y / dstStd
    h00 += rx * sx
    h01 += rx * sy
    h10 += ry * sx
    h11 += ry * sy
  })
  const rotation = Math.atan2(h10 - h01, h00 + h11)
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const tx = -scale * (cos * sc.x - sin * sc.y) + dc.x
  const ty = -scale * (sin * sc.x + cos * sc.y) + dc.y
  return { scale, rotation, tx, ty }
}

/** Affine form of a similarity (legacy a, b, c, d, tx, ty). */
export function similarityToAffine(s: Similarity): Affine {
  const cos = Math.cos(s.rotation)
  const sin = Math.sin(s.rotation)
  return { a: s.scale * cos, b: s.scale * sin, c: -s.scale * sin, d: s.scale * cos, e: s.tx, f: s.ty }
}

/** Scales normalized points to pixels per axis (legacy `scalePoints`). */
function toPixels(points: readonly Point[], size: Size): Point[] {
  return points.map((p) => ({ x: p.x * size.width, y: p.y * size.height }))
}

/**
 * Affine mapping source-image pixels to destination-frame pixels so the source
 * anchors land on the destination anchors. Anchors are normalized to their own
 * image; `srcSize` is the pixel size of the image actually displayed (e.g. the
 * thumbnail's natural size), `dstSize` the destination frame's pixel size.
 */
export function alignToReference(
  srcAnchorsNorm: readonly Point[],
  srcSize: Size,
  dstAnchorsNorm: readonly Point[],
  dstSize: Size,
): Affine {
  const similarity = similarityTransform(toPixels(srcAnchorsNorm, srcSize), toPixels(dstAnchorsNorm, dstSize))
  return similarityToAffine(similarity)
}

/** Applies an affine to a point. */
export function applyAffine(m: Affine, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

/** Fixed-precision CSS number without exponent or negative zero. */
function cssNumber(x: number): string {
  const rounded = Number(x.toFixed(CSS_DECIMALS))
  return String(rounded === 0 ? 0 : rounded)
}

/**
 * CSS `matrix(...)` for an `<img>` at its natural pixel size with
 * `transform-origin: 0 0`, inside a box that shows the destination frame at
 * `displayScaleX/Y` CSS px per destination pixel (box width / dstSize.width).
 */
export function toCssMatrix(affine: Affine, displayScaleX: number, displayScaleY: number): string {
  const { a, b, c, d, e, f } = affine
  const values = [a * displayScaleX, b * displayScaleY, c * displayScaleX, d * displayScaleY, e * displayScaleX, f * displayScaleY]
  return `matrix(${values.map(cssNumber).join(', ')})`
}
