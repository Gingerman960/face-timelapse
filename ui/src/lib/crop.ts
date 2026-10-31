// ui/src/lib/crop.ts
// Reference crop math in IMAGE PIXEL space (ReferenceState.crop is pixels of
// ReferenceImage.size). Port of the legacy SetupView math (computeARCrop,
// clampBox, AR-locked handles, Center face, nudge) with the B31/B38 fix: an
// aspect-locked crop keeps its aspect at the image borders. Every result is
// integer pixels, inside the image, ≥ MIN_CROP_SIZE on both sides (when the
// image allows it) and within ASPECT_TOLERANCE of the preset.
import type { AspectPreset, Rect, Size } from '../ipc/contract'

export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export type NudgeKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

/** Backend minimum crop side, pixels. */
export const MIN_CROP_SIZE = 32
/** Backend aspect tolerance (relative). */
export const ASPECT_TOLERANCE = 0.01
export const ASPECT_PRESETS: readonly AspectPreset[] = ['free', '1:1', '4:3', '3:4', '4:5', '16:9', '9:16']
export const NUDGE_STEP = 1
export const NUDGE_STEP_SHIFT = 10

const FULL_IMAGE_TOLERANCE = 1
/** Snapped sizes stay within this aspect error, well inside the backend's 1 %. */
const SNAP_TOLERANCE = 0.004
/** Search radius for a better-fitting short side; ≥ the largest preset term − 1. */
const SNAP_SEARCH = 8

/** Integer aspect terms (width : height). */
interface Ratio {
  readonly w: number
  readonly h: number
}

const RATIOS: Readonly<Record<Exclude<AspectPreset, 'free'>, Ratio>> = {
  '1:1': { w: 1, h: 1 },
  '4:3': { w: 4, h: 3 },
  '3:4': { w: 3, h: 4 },
  '4:5': { w: 4, h: 5 },
  '16:9': { w: 16, h: 9 },
  '9:16': { w: 9, h: 16 },
}

const NUDGE_VECTORS: Readonly<Record<NudgeKey, readonly [number, number]>> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
}

/** Clamps `v` into [lo, hi]; returns `lo` when the range is empty. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Non-finite pointer deltas count as no movement. */
function finiteOrZero(v: number): number {
  return Number.isFinite(v) ? v : 0
}

/** Integer aspect terms, null for free. */
function ratioOf(aspect: AspectPreset): Ratio | null {
  return aspect === 'free' ? null : RATIOS[aspect]
}

/** Width / height of a preset, null for free. */
export function aspectRatioOf(preset: AspectPreset): number | null {
  const ratio = ratioOf(preset)
  return ratio === null ? null : ratio.w / ratio.h
}

/** Short side of a `ratio` box with the given width. */
function shortFromWidth(width: number, ratio: Ratio): number {
  return ratio.w >= ratio.h ? (width * ratio.h) / ratio.w : width
}

/** Short side of a `ratio` box with the given height. */
function shortFromHeight(height: number, ratio: Ratio): number {
  return ratio.w >= ratio.h ? height : (height * ratio.w) / ratio.h
}

/** Relative error of rounding the long side for short side `s`. */
function roundingError(s: number, long: number, short: number): number {
  const exact = (s * long) / short
  return Math.abs(Math.round(exact) - exact) / exact
}

/** Nearest short side to `base` in [lo, hi] whose rounded long side keeps the aspect within SNAP_TOLERANCE. */
function snapShort(base: number, lo: number, hi: number, long: number, short: number): number {
  for (let k = 0; k <= SNAP_SEARCH; k++) {
    for (const s of [base - k, base + k]) {
      if (s >= lo && s <= hi && roundingError(s, long, short) <= SNAP_TOLERANCE) return s
    }
  }
  return base
}

/** Integer `ratio` size with short side near `targetShort`, inside maxW×maxH, short side ≥ minShort when it fits. */
function lockedSize(targetShort: number, ratio: Ratio, maxW: number, maxH: number, minShort: number): Size {
  const landscape = ratio.w >= ratio.h
  const long = landscape ? ratio.w : ratio.h
  const short = landscape ? ratio.h : ratio.w
  const limitShort = landscape ? Math.floor(maxH) : Math.floor(maxW)
  const limitLong = landscape ? Math.floor(maxW) : Math.floor(maxH)
  const maxShort = Math.max(1, Math.min(limitShort, Math.floor((limitLong * short) / long)))
  const lo = Math.min(minShort, maxShort)
  const s = snapShort(clamp(Math.round(targetShort), lo, maxShort), lo, maxShort, long, short)
  const l = Math.round((s * long) / short)
  return landscape ? { width: l, height: s } : { width: s, height: l }
}

/** Start coordinate that centres `length` on `center`, kept inside [0, limit]. */
function centeredStart(center: number, length: number, limit: number): number {
  return clamp(Math.round(center - length / 2), 0, limit - length)
}

/** Places a size centred on (cx, cy), shifted to stay inside the image. */
function placeCentered(dims: Size, cx: number, cy: number, size: Size): Rect {
  return { x: centeredStart(cx, dims.width, size.width), y: centeredStart(cy, dims.height, size.height), ...dims }
}

/** Free crop: whole image; otherwise the largest centred crop of the aspect (legacy computeARCrop). */
export function defaultCrop(size: Size, aspect: AspectPreset): Rect {
  return reshapeToAspect({ x: 0, y: 0, width: size.width, height: size.height }, size, aspect)
}

/** Aspect change: the largest crop of the new aspect around the current centre (legacy; free = whole image). */
export function reshapeToAspect(crop: Rect, size: Size, aspect: AspectPreset): Rect {
  const ratio = ratioOf(aspect)
  if (ratio === null) return { x: 0, y: 0, width: size.width, height: size.height }
  const dims = lockedSize(Number.POSITIVE_INFINITY, ratio, size.width, size.height, MIN_CROP_SIZE)
  return placeCentered(dims, crop.x + crop.width / 2, crop.y + crop.height / 2, size)
}

/** Integer, ≥ min, inside the image, keeping the centre where possible; locked aspects shrink uniformly (B31 fix). */
export function clampCrop(crop: Rect, size: Size, aspect: AspectPreset): Rect {
  const cx = crop.x + crop.width / 2
  const cy = crop.y + crop.height / 2
  const ratio = ratioOf(aspect)
  if (ratio === null) {
    const width = clamp(Math.round(crop.width), Math.min(MIN_CROP_SIZE, size.width), size.width)
    const height = clamp(Math.round(crop.height), Math.min(MIN_CROP_SIZE, size.height), size.height)
    return placeCentered({ width, height }, cx, cy, size)
  }
  const fitShort = Math.min(shortFromWidth(crop.width, ratio), shortFromHeight(crop.height, ratio))
  return placeCentered(lockedSize(fitShort, ratio, size.width, size.height, MIN_CROP_SIZE), cx, cy, size)
}

/** Moves the crop by (dx, dy) image pixels, stopping at the borders. */
export function moveCrop(crop: Rect, dx: number, dy: number, size: Size): Rect {
  return {
    ...crop,
    x: clamp(Math.round(crop.x + finiteOrZero(dx)), 0, size.width - crop.width),
    y: clamp(Math.round(crop.y + finiteOrZero(dy)), 0, size.height - crop.height),
  }
}

/** Free resize: each dragged edge moves independently, ≥ minSize, inside the image. */
function resizeFree(crop: Rect, handle: CropHandle, dx: number, dy: number, size: Size, minSize: number): Rect {
  const minW = Math.min(minSize, size.width)
  const minH = Math.min(minSize, size.height)
  const right0 = crop.x + crop.width
  const bottom0 = crop.y + crop.height
  const left = handle.includes('w') ? clamp(Math.round(crop.x + dx), 0, right0 - minW) : crop.x
  const top = handle.includes('n') ? clamp(Math.round(crop.y + dy), 0, bottom0 - minH) : crop.y
  const right = handle.includes('e') ? clamp(Math.round(right0 + dx), left + minW, size.width) : right0
  const bottom = handle.includes('s') ? clamp(Math.round(bottom0 + dy), top + minH, size.height) : bottom0
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Aspect-locked resize: corners anchor the opposite corner (dominant drag axis drives), edges keep the other axis centred. */
function resizeLocked(crop: Rect, handle: CropHandle, dx: number, dy: number, size: Size, ratio: Ratio, minSize: number): Rect {
  const hasN = handle.includes('n')
  const hasS = handle.includes('s')
  const hasW = handle.includes('w')
  const hasE = handle.includes('e')
  const horizontal = hasE || hasW
  const vertical = hasN || hasS
  const right = crop.x + crop.width
  const bottom = crop.y + crop.height
  const widthFromX = hasE ? crop.width + dx : crop.width - dx
  const widthFromY = ((hasS ? crop.height + dy : crop.height - dy) * ratio.w) / ratio.h
  const xDominates = Math.abs(widthFromX - crop.width) >= Math.abs(widthFromY - crop.width)
  const targetWidth = horizontal && (!vertical || xDominates) ? widthFromX : widthFromY
  const maxW = horizontal ? (hasE ? size.width - crop.x : right) : size.width
  const maxH = vertical ? (hasS ? size.height - crop.y : bottom) : size.height
  const dims = lockedSize(shortFromWidth(targetWidth, ratio), ratio, maxW, maxH, minSize)
  const x = horizontal ? (hasW ? right - dims.width : crop.x) : centeredStart(crop.x + crop.width / 2, dims.width, size.width)
  const y = vertical ? (hasN ? bottom - dims.height : crop.y) : centeredStart(crop.y + crop.height / 2, dims.height, size.height)
  return { x, y, ...dims }
}

/** Resizes the drag-start `crop` by the total pointer movement (dx, dy) in image pixels. */
export function resizeCrop(
  crop: Rect,
  handle: CropHandle,
  dx: number,
  dy: number,
  size: Size,
  aspect: AspectPreset,
  minSize: number = MIN_CROP_SIZE,
): Rect {
  const ratio = ratioOf(aspect)
  const [ddx, ddy] = [finiteOrZero(dx), finiteOrZero(dy)]
  return ratio === null
    ? resizeFree(crop, handle, ddx, ddy, size, minSize)
    : resizeLocked(crop, handle, ddx, ddy, size, ratio, minSize)
}

/** Legacy Center face: centre on `faceBoundsNorm` (normalized to the image), shrinking only if needed to keep it centred. */
export function centerFaceCrop(crop: Rect, faceBoundsNorm: Rect, size: Size, aspect: AspectPreset): Rect {
  const { x, y, width, height } = faceBoundsNorm
  if (![x, y, width, height].every(Number.isFinite)) return crop
  const fcx = (x + width / 2) * size.width
  const fcy = (y + height / 2) * size.height
  const maxW = 2 * Math.min(fcx, size.width - fcx)
  const maxH = 2 * Math.min(fcy, size.height - fcy)
  const ratio = ratioOf(aspect)
  if (ratio === null) {
    const w = clamp(Math.min(crop.width, Math.floor(maxW)), Math.min(MIN_CROP_SIZE, size.width), size.width)
    const h = clamp(Math.min(crop.height, Math.floor(maxH)), Math.min(MIN_CROP_SIZE, size.height), size.height)
    return placeCentered({ width: w, height: h }, fcx, fcy, size)
  }
  const targetShort = Math.min(
    shortFromWidth(Math.min(crop.width, maxW), ratio),
    shortFromHeight(Math.min(crop.height, maxH), ratio),
  )
  return placeCentered(lockedSize(targetShort, ratio, size.width, size.height, MIN_CROP_SIZE), fcx, fcy, size)
}

/** Type guard for keyboard nudge keys. */
export function isNudgeKey(key: string): key is NudgeKey {
  return Object.hasOwn(NUDGE_VECTORS, key)
}

/** Arrow-key nudge: 1 px, or 10 px with Shift. */
export function nudgeCrop(crop: Rect, key: NudgeKey, shift: boolean, size: Size): Rect {
  const [ux, uy] = NUDGE_VECTORS[key]
  const step = shift ? NUDGE_STEP_SHIFT : NUDGE_STEP
  return moveCrop(crop, ux * step, uy * step, size)
}

/** True when the crop covers the whole image (1 px tolerance, like the backend). */
export function isFullImage(crop: Rect, size: Size): boolean {
  return (
    Math.abs(crop.x) <= FULL_IMAGE_TOLERANCE &&
    Math.abs(crop.y) <= FULL_IMAGE_TOLERANCE &&
    Math.abs(crop.x + crop.width - size.width) <= FULL_IMAGE_TOLERANCE &&
    Math.abs(crop.y + crop.height - size.height) <= FULL_IMAGE_TOLERANCE
  )
}

/** Whether the crop matches the preset within 1 % (always true for free with a non-empty crop). */
export function cropMatchesAspect(crop: Rect, aspect: AspectPreset): boolean {
  if (!(crop.width > 0 && crop.height > 0)) return false
  const ratio = ratioOf(aspect)
  if (ratio === null) return true
  return Math.abs(crop.width * ratio.h - crop.height * ratio.w) <= ASPECT_TOLERANCE * crop.height * ratio.w
}
