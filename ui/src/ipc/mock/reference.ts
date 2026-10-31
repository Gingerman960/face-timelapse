// Reference photo model → contract ReferenceState, plus rotation/crop updates.
import type { AspectPreset, IpcError, Rect, ReferenceDetection, ReferenceState } from '../contract'
import { invalid } from './errors'
import { type ReferenceGeometry, detectionFor, referenceGeometry } from './fixtures'
import { ASPECT_RATIOS, defaultCrop, rotateCrop } from './geometry'
import { baseName } from './mockFs'
import { round } from './random'
import type { ReferenceModel } from './state'
import { type ReferenceVariant, encodeReferenceFrameVersion, encodeReferenceImageVersion } from './versions'

const MIN_CROP_PX = 32
const CROP_TOLERANCE_PX = 1
const ASPECT_TOLERANCE = 0.01
export const MAX_ROTATION_DEG = 45

const geometryCache = new WeakMap<ReferenceModel, ReferenceGeometry>()

export function geometryOf(ref: ReferenceModel): ReferenceGeometry {
  const hit = geometryCache.get(ref)
  if (hit) return hit
  const geometry = referenceGeometry(ref.rotationDeg, ref.variant === 'portrait')
  geometryCache.set(ref, geometry)
  return geometry
}

export function detectionOf(ref: ReferenceModel | null): ReferenceDetection | null {
  return ref ? detectionFor(geometryOf(ref), ref.crop) : null
}

export function newReference(path: string, variant: ReferenceVariant): ReferenceModel {
  const geometry = referenceGeometry(0, variant === 'portrait')
  return { path, variant, rotationDeg: 0, crop: defaultCrop(geometry.size, 'free'), aspect: 'free' }
}

/** New rotation; the crop turns with the photo (`reference::rotate_crop`), so the face stays in it. */
export function rotateReference(ref: ReferenceModel, rotationDeg: number): ReferenceModel {
  const from = { size: geometryOf(ref).size, deg: ref.rotationDeg }
  const to = { size: referenceGeometry(rotationDeg, false).size, deg: rotationDeg }
  return { ...ref, rotationDeg, crop: rotateCrop(ref.crop, from, to, ref.aspect) }
}

/** Validates a crop against the rotated canvas (§7.2: 1 px tolerance, ≥ 32 px, aspect within 1 %). */
export function cropError(ref: ReferenceModel, crop: Rect, aspect: AspectPreset): IpcError | null {
  const { size } = geometryOf(ref)
  const t = CROP_TOLERANCE_PX
  if (
    crop.x < -t ||
    crop.y < -t ||
    crop.x + crop.width > size.width + t ||
    crop.y + crop.height > size.height + t
  ) {
    return invalid('The crop must stay inside the photo.')
  }
  if (crop.width < MIN_CROP_PX || crop.height < MIN_CROP_PX) {
    return invalid(`The crop must be at least ${MIN_CROP_PX} × ${MIN_CROP_PX} pixels.`)
  }
  if (aspect !== 'free') {
    const ratio = crop.width / crop.height / ASPECT_RATIOS[aspect]
    if (Math.abs(ratio - 1) > ASPECT_TOLERANCE) return invalid(`The crop doesn't match the ${aspect} aspect.`)
  }
  return null
}

/** Applies a validated crop, clamped into the canvas. */
export function cropReference(ref: ReferenceModel, crop: Rect, aspect: AspectPreset): ReferenceModel {
  const { size } = geometryOf(ref)
  const x = Math.max(0, crop.x)
  const y = Math.max(0, crop.y)
  return {
    ...ref,
    aspect,
    crop: { x, y, width: Math.min(crop.width, size.width - x), height: Math.min(crop.height, size.height - y) },
  }
}

export function referenceStateOf(ref: ReferenceModel): ReferenceState {
  const geometry = geometryOf(ref)
  const rotation = round(ref.rotationDeg, 3)
  const cropKey = [ref.crop.x, ref.crop.y, ref.crop.width, ref.crop.height].join(',')
  return {
    image: {
      path: ref.path,
      fileName: baseName(ref.path),
      rotationDeg: ref.rotationDeg,
      autoRotationDeg: geometry.autoRotationDeg,
      size: geometry.size,
      face: geometry.face,
      version: encodeReferenceImageVersion(`${ref.path}|${rotation}`, {
        rotationDeg: ref.rotationDeg,
        variant: ref.variant,
      }),
    },
    crop: ref.crop,
    aspect: ref.aspect,
    detection: detectionOf(ref),
    version: encodeReferenceFrameVersion(`${ref.path}|${rotation}|${cropKey}|${ref.aspect}`, {
      rotationDeg: ref.rotationDeg,
      crop: ref.crop,
      variant: ref.variant,
    }),
  }
}
