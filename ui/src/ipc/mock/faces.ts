// Synthetic face geometry: the reference photo's fixed face and per-photo faces
// built from the same template, so library anchors are a near-similarity of
// the reference anchors (small residuals, like real alignment).
import type { FaceGeometry, Point, Rect, ReferenceDetection, Size } from '../contract'
import { boundsOf, containsPoint, cornersOf, intersect, rotatePoint, rotatedSize } from './geometry'
import { type Rng, clamp, randRange, round } from './random'

/** Reference photo (oriented, unrotated) pixel size. */
export const REFERENCE_SIZE: Size = { width: 3200, height: 2368 }

/** Reference face, normalized to REFERENCE_SIZE. */
export const REFERENCE_FACE: FaceGeometry = {
  bounds: { x: 0.385, y: 0.25, width: 0.23, height: 0.48 },
  anchors: [
    { x: 0.4325, y: 0.4016 },
    { x: 0.572, y: 0.4016 },
    { x: 0.4965, y: 0.522 },
    { x: 0.443, y: 0.625 },
    { x: 0.563, y: 0.625 },
  ],
  confidence: 0.98,
}

/**
 * Eye-levelling suggestion for the reference: absolute, relative to the
 * EXIF-oriented photo, like the engine's (INTEGRATION-NOTES §4). Below the
 * 0.3° "apply only if" threshold (ARCHITECTURE §7.3), so the restored
 * reference reads as level.
 */
export const REFERENCE_AUTO_ROTATION_DEG = -0.2

/** Anchors as fractions of the face bounds (derived from REFERENCE_FACE). */
const TEMPLATE: readonly Point[] = REFERENCE_FACE.anchors.map((a) => ({
  x: (a.x - REFERENCE_FACE.bounds.x) / REFERENCE_FACE.bounds.width,
  y: (a.y - REFERENCE_FACE.bounds.y) / REFERENCE_FACE.bounds.height,
}))

/** Face box height / width in pixels (from the reference face). */
export const FACE_BOX_ASPECT =
  (REFERENCE_FACE.bounds.height * REFERENCE_SIZE.height) / (REFERENCE_FACE.bounds.width * REFERENCE_SIZE.width)

const ANCHOR_DIGITS = 4

function normalizePoint(p: Point, size: Size): Point {
  return { x: round(p.x / size.width, ANCHOR_DIGITS), y: round(p.y / size.height, ANCHOR_DIGITS) }
}

function normalizeRect(r: Rect, size: Size): Rect {
  return {
    x: round(r.x / size.width, ANCHOR_DIGITS),
    y: round(r.y / size.height, ANCHOR_DIGITS),
    width: round(r.width / size.width, ANCHOR_DIGITS),
    height: round(r.height / size.height, ANCHOR_DIGITS),
  }
}

/** Face geometry → pixel anchors for an image of `size`. */
export function anchorsPx(face: FaceGeometry, size: Size): Point[] {
  return face.anchors.map((a) => ({ x: a.x * size.width, y: a.y * size.height }))
}

/** Face bounds → pixels for an image of `size`. */
export function boundsPx(face: FaceGeometry, size: Size): Rect {
  return {
    x: face.bounds.x * size.width,
    y: face.bounds.y * size.height,
    width: face.bounds.width * size.width,
    height: face.bounds.height * size.height,
  }
}

/** A face whose box (pixels) is `box`, rolled by `rollDeg`, with a little landmark jitter. */
export function faceInBox(box: Rect, size: Size, rollDeg: number, confidence: number, rng: Rng): FaceGeometry {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const roll = (rollDeg * Math.PI) / 180
  const cos = Math.cos(roll)
  const sin = Math.sin(roll)
  const jitter = box.width * 0.006
  const anchors = TEMPLATE.map((t) => {
    const dx = box.x + t.x * box.width - cx
    const dy = box.y + t.y * box.height - cy
    const p = {
      x: cx + dx * cos - dy * sin + randRange(rng, -jitter, jitter),
      y: cy + dx * sin + dy * cos + randRange(rng, -jitter, jitter),
    }
    return normalizePoint(p, size)
  })
  return { bounds: normalizeRect(box, size), anchors, confidence: round(confidence, 3) }
}

/** Pixel face box of a given width centred at (cx, eyeY): eyes sit at the template's eye line. */
export function boxAt(cx: number, eyeY: number, width: number, size: Size): Rect {
  const height = width * FACE_BOX_ASPECT
  const eyeFraction = TEMPLATE[0]?.y ?? 0.316
  const x = clamp(cx - width / 2, 0, size.width - width)
  const y = clamp(eyeY - eyeFraction * height, size.height * 0.02, size.height * 0.98 - height)
  return { x, y, width, height }
}

/* ─────────────── Reference geometry under rotation ─────────────── */

export interface ReferenceGeometry {
  /** Rotated canvas size (crop coordinates live here). */
  size: Size
  /** Whole-image face normalized to `size`, null for a photo without a face. */
  face: FaceGeometry | null
  autoRotationDeg: number | null
}

/** Rotates the reference face with the canvas (clockwise degrees, canvas expands). */
export function referenceGeometry(rotationDeg: number, hasFace: boolean): ReferenceGeometry {
  const size = rotatedSize(REFERENCE_SIZE, rotationDeg)
  if (!hasFace) return { size, face: null, autoRotationDeg: null }
  const map = (p: Point) => rotatePoint(p, REFERENCE_SIZE, size, rotationDeg)
  const anchors = anchorsPx(REFERENCE_FACE, REFERENCE_SIZE).map(map)
  const box = boundsOf(cornersOf(boundsPx(REFERENCE_FACE, REFERENCE_SIZE)).map(map))
  const face: FaceGeometry = {
    bounds: normalizeRect(box, size),
    anchors: anchors.map((p) => normalizePoint(p, size)),
    confidence: REFERENCE_FACE.confidence,
  }
  return { size, face, autoRotationDeg: REFERENCE_AUTO_ROTATION_DEG }
}

const DETECTION_CONFIDENCE = 0.97

/**
 * Detection on the crop: anchors and face box normalized to the crop, or null
 * when the photo has no face or any anchor falls outside the crop.
 */
export function detectionFor(geometry: ReferenceGeometry, crop: Rect): ReferenceDetection | null {
  if (!geometry.face || crop.width <= 0 || crop.height <= 0) return null
  const px = anchorsPx(geometry.face, geometry.size)
  if (!px.every((p) => containsPoint(crop, p))) return null
  const toCrop = (p: Point): Point => ({
    x: round((p.x - crop.x) / crop.width, ANCHOR_DIGITS),
    y: round((p.y - crop.y) / crop.height, ANCHOR_DIGITS),
  })
  const box = intersect(boundsPx(geometry.face, geometry.size), crop)
  const origin = toCrop(box)
  return {
    anchors: px.map(toCrop),
    faceBox: {
      x: origin.x,
      y: origin.y,
      width: round(box.width / crop.width, ANCHOR_DIGITS),
      height: round(box.height / crop.height, ANCHOR_DIGITS),
    },
    confidence: DETECTION_CONFIDENCE,
  }
}
