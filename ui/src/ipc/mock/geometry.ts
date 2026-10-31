// Pure geometry shared by the fake backend and the mock image server:
// output sizes (port of timelapse-video's Resolution::output_size), rotation of
// the reference canvas, default crops and the legacy Procrustes transform.
import type { AspectPreset, FrameAdjust, Point, Rect, Resolution, Size } from '../contract'

export const ASPECT_PRESETS: readonly AspectPreset[] = ['free', '1:1', '4:3', '3:4', '4:5', '16:9', '9:16']

/** Width / height of each fixed aspect preset. */
export const ASPECT_RATIOS: Readonly<Record<Exclude<AspectPreset, 'free'>, number>> = {
  '1:1': 1,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '4:5': 4 / 5,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
}

export const RESOLUTIONS: readonly Resolution[] = ['source', '2160p', '1080p', '720p']

/* ─────────────── timelapse-video geometry (crates/timelapse-video/src/geometry.rs) ─────────────── */

const MAX_LONG_SIDE = 3840
const MAX_SHORT_SIDE = 2160
const MIN_SIDE = 16

const BOUNDING_BOX: Readonly<Record<Resolution, readonly [number, number] | null>> = {
  source: null,
  '2160p': [3840, 2160],
  '1080p': [1920, 1080],
  '720p': [1280, 720],
}

/** Rounds to the nearest even integer (ties go up), never below 2. */
export function roundEven(x: number): number {
  return Math.max(1, Math.round(x / 2)) * 2
}

function fitEven(srcW: number, srcH: number, boxW: number, boxH: number): Size {
  const scale = Math.min(boxW / srcW, boxH / srcH)
  const w = Math.min(roundEven(srcW * scale), boxW & ~1)
  const h = Math.min(roundEven(srcH * scale), boxH & ~1)
  return { width: Math.max(w, MIN_SIDE), height: Math.max(h, MIN_SIDE) }
}

/**
 * Output size for a source (crop) of `srcW × srcH` pixels: the largest even
 * rectangle with the source aspect inside the preset's bounding box, oriented
 * like the source. `source` keeps the size (even, capped to 3840×2160).
 * Returns null for an empty source.
 */
export function outputSizeFor(resolution: Resolution, srcW: number, srcH: number): Size | null {
  const w = Math.round(srcW)
  const h = Math.round(srcH)
  if (w <= 0 || h <= 0) return null
  const landscape = w >= h
  const box = BOUNDING_BOX[resolution]
  const [boxLong, boxShort] =
    box ?? [Math.min(landscape ? w : h, MAX_LONG_SIDE), Math.min(landscape ? h : w, MAX_SHORT_SIDE)]
  const [boxW, boxH] = landscape ? [boxLong, boxShort] : [boxShort, boxLong]
  return fitEven(w, h, boxW, boxH)
}

/* ─────────────── Rotation of the reference canvas ─────────────── */

const DEG = Math.PI / 180

/** Canvas size after rotating `size` by `deg` (the canvas expands, black fill). */
export function rotatedSize(size: Size, deg: number): Size {
  const c = Math.abs(Math.cos(deg * DEG))
  const s = Math.abs(Math.sin(deg * DEG))
  return {
    width: Math.round(size.width * c + size.height * s),
    height: Math.round(size.width * s + size.height * c),
  }
}

/** Maps a pixel of the unrotated image into the expanded canvas rotated clockwise by `deg` (y down). */
export function rotatePoint(p: Point, size: Size, rotated: Size, deg: number): Point {
  const cos = Math.cos(deg * DEG)
  const sin = Math.sin(deg * DEG)
  const dx = p.x - size.width / 2
  const dy = p.y - size.height / 2
  return {
    x: rotated.width / 2 + dx * cos - dy * sin,
    y: rotated.height / 2 + dx * sin + dy * cos,
  }
}

/** Axis-aligned bounds of a set of points. */
export function boundsOf(points: readonly Point[]): Rect {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** Corners of a rectangle, clockwise from the top-left. */
export function cornersOf(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ]
}

/* ─────────────── Crops ─────────────── */

/** Default crop: whole image for `free`, else the largest centred crop of that aspect (integer pixels). */
export function defaultCrop(size: Size, aspect: AspectPreset): Rect {
  if (aspect === 'free') return { x: 0, y: 0, width: size.width, height: size.height }
  const ratio = ASPECT_RATIOS[aspect]
  if (size.width / size.height > ratio) {
    const width = Math.round(size.height * ratio)
    return { x: Math.round((size.width - width) / 2), y: 0, width, height: size.height }
  }
  const height = Math.round(size.width / ratio)
  return { x: 0, y: Math.round((size.height - height) / 2), width: size.width, height }
}

/** A rotated reference canvas: its size and the photo's rotation on it. */
export interface RotatedCanvas {
  readonly size: Size
  readonly deg: number
}

/**
 * Carries a crop from one rotated canvas to another, like the backend's
 * `reference::rotate_crop`: its centre turns with the photo about the canvas
 * centres; it shrinks only when the new canvas can't hold it (a fixed aspect
 * scales as a whole, `free` clips each side) and is clamped inside.
 */
export function rotateCrop(crop: Rect, from: RotatedCanvas, to: RotatedCanvas, aspect: AspectPreset): Rect {
  const centre = rotatePoint({ x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 }, from.size, to.size, to.deg - from.deg)
  const { width: pw, height: ph } = to.size
  const k = Math.min(pw / crop.width, ph / crop.height, 1)
  const width = aspect === 'free' ? Math.min(crop.width, pw) : crop.width * k
  const height = aspect === 'free' ? Math.min(crop.height, ph) : crop.height * k
  const within = (v: number, max: number) => Math.min(Math.max(v, 0), Math.max(max, 0))
  return { x: within(centre.x - width / 2, pw - width), y: within(centre.y - height / 2, ph - height), width, height }
}

/** True when `p` (pixels) lies inside `r` (edges included). */
export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

/** Intersection of two rectangles (empty rectangles have zero size). */
export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

/* ─────────────── Affine transforms (canvas order: a b c d e f) ─────────────── */

/** x' = a·x + c·y + e, y' = b·x + d·y + f (SVG `matrix(a b c d e f)`). */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

export function applyAffine(m: Affine, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

/** `outer ∘ inner`: apply `inner` first, then `outer`. */
export function composeAffine(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  }
}

/**
 * Legacy Procrustes (LEGACY-SPEC §4.10): RMS-ratio scale, angle from the
 * cross-covariance, identity fallback. Maps `src` points onto `ref` points.
 */
export function procrustes(src: readonly Point[], ref: readonly Point[]): Affine {
  const n = src.length
  if (n < 3 || n !== ref.length) return IDENTITY
  const mean = (pts: readonly Point[]): Point => ({
    x: pts.reduce((s, p) => s + p.x, 0) / n,
    y: pts.reduce((s, p) => s + p.y, 0) / n,
  })
  const ms = mean(src)
  const mr = mean(ref)
  const rms = (pts: readonly Point[], m: Point): number =>
    Math.sqrt(pts.reduce((s, p) => s + (p.x - m.x) ** 2 + (p.y - m.y) ** 2, 0) / n)
  const ss = rms(src, ms)
  const sr = rms(ref, mr)
  if (ss === 0 || sr === 0) return IDENTITY
  let h00 = 0
  let h01 = 0
  let h10 = 0
  let h11 = 0
  for (let i = 0; i < n; i++) {
    const s = src[i] as Point
    const r = ref[i] as Point
    const sx = (s.x - ms.x) / ss
    const sy = (s.y - ms.y) / ss
    const rx = (r.x - mr.x) / sr
    const ry = (r.y - mr.y) / sr
    h00 += rx * sx
    h01 += rx * sy
    h10 += ry * sx
    h11 += ry * sy
  }
  const theta = Math.atan2(h10 - h01, h00 + h11)
  const scale = sr / ss
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return {
    a: scale * cos,
    b: scale * sin,
    c: -scale * sin,
    d: scale * cos,
    e: -scale * (cos * ms.x - sin * ms.y) + mr.x,
    f: -scale * (sin * ms.x + cos * ms.y) + mr.y,
  }
}

/** FrameAdjust as an output-space affine: rotate/scale about the centre, then translate (§9.5). */
export function adjustAffine(adjust: FrameAdjust, out: Size): Affine {
  const cx = out.width / 2
  const cy = out.height / 2
  const cos = Math.cos(adjust.rotationDeg * DEG) * adjust.scale
  const sin = Math.sin(adjust.rotationDeg * DEG) * adjust.scale
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: cx - cos * cx + sin * cy + adjust.dx * out.width,
    f: cy - sin * cx - cos * cy + adjust.dy * out.height,
  }
}

/** RMS distance between two point lists of equal length. */
export function rmsDistance(a: readonly Point[], b: readonly Point[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as Point
    const q = b[i] as Point
    sum += (p.x - q.x) ** 2 + (p.y - q.y) ** 2
  }
  return Math.sqrt(sum / a.length)
}
