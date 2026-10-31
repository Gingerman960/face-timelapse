// Version tokens for the mock image routes.
//
// `Version` is opaque lowercase hex in the contract. The mock packs the render
// parameters the image server needs (look, frame adjust, reference rotation and
// crop, resolution, backdrop) into the token after a short content hash, so the
// stateless Vite middleware can draw what the in-browser fake backend means
// without sharing state. The UI never parses these tokens.
import type {
  BackdropMode,
  FrameAdjust,
  LookSettings,
  NormalizeMode,
  Rect,
  Resolution,
  Version,
} from '../contract'
import { RESOLUTIONS } from './geometry'
import { clamp, hashHex, round } from './random'

export type ReferenceVariant = 'portrait' | 'noFace'

export interface ReferenceImageParams {
  rotationDeg: number
  variant: ReferenceVariant
}

export interface ReferenceFrameParams extends ReferenceImageParams {
  /** Pixels of the rotated reference canvas. */
  crop: Rect
}

export interface FrameRenderParams extends ReferenceFrameParams {
  look: LookSettings
  adjust: FrameAdjust
  resolution: Resolution
  backdrop: BackdropMode
}

const NORMALIZE_MODES: readonly NormalizeMode[] = ['off', 'exposure', 'exposureAndColor']
const BACKDROPS: readonly BackdropMode[] = ['dimmed', 'blurred', 'black', 'extended']
const VARIANTS: readonly ReferenceVariant[] = ['portrait', 'noFace']

const TAG_FRAME = 'f'
const TAG_REFERENCE_FRAME = 'c'
const TAG_REFERENCE_IMAGE = 'e'
const HASH_LEN = 8

/* ─────────────── Field codec ─────────────── */

interface Field {
  width: number
  encode: (q: number) => number
}

function hexField(value: number, width: number): string {
  const max = 16 ** width - 1
  return clamp(Math.round(value), 0, max).toString(16).padStart(width, '0')
}

class Reader {
  private offset: number
  constructor(
    private readonly text: string,
    start: number,
  ) {
    this.offset = start
  }
  next(width: number): number {
    const slice = this.text.slice(this.offset, this.offset + width)
    this.offset += width
    return Number.parseInt(slice, 16)
  }
}

const Q = {
  rotation: { width: 3, encode: (deg: number) => (deg + 45) * 40 } satisfies Field,
  strength: { width: 2, encode: (s: number) => s * 100 } satisfies Field,
  shift: { width: 3, encode: (v: number) => (v + 0.25) * 4000 } satisfies Field,
  scale: { width: 3, encode: (s: number) => (s - 0.5) * 2000 } satisfies Field,
  tilt: { width: 3, encode: (deg: number) => (deg + 20) * 100 } satisfies Field,
}

function indexOf<T>(values: readonly T[], value: T): number {
  return Math.max(0, values.indexOf(value))
}

function enumAt<T>(values: readonly T[], index: number): T | null {
  return values[index] ?? null
}

function encodeReferenceFields(p: ReferenceFrameParams): string {
  return (
    hexField(Q.rotation.encode(p.rotationDeg), Q.rotation.width) +
    hexField(p.crop.x, 4) +
    hexField(p.crop.y, 4) +
    hexField(p.crop.width, 4) +
    hexField(p.crop.height, 4) +
    hexField(indexOf(VARIANTS, p.variant), 1)
  )
}

function decodeReferenceFields(r: Reader): ReferenceFrameParams | null {
  const rotationDeg = round(r.next(3) / 40 - 45, 3)
  const crop = { x: r.next(4), y: r.next(4), width: r.next(4), height: r.next(4) }
  const variant = enumAt(VARIANTS, r.next(1))
  if (variant === null) return null
  return { rotationDeg, crop, variant }
}

/* ─────────────── Frame versions (aligned route) ─────────────── */

const FRAME_LEN = 1 + HASH_LEN + 1 + 2 + 3 * 4 + 3 + 16 + 1 + 1 + 1

/** Frame version: 'f' + 8-hex content hash + packed render parameters (46 hex chars). */
export function encodeFrameVersion(seed: string, p: FrameRenderParams): Version {
  return (
    TAG_FRAME +
    hashHex(`frame:${seed}`, HASH_LEN) +
    hexField(indexOf(NORMALIZE_MODES, p.look.normalize), 1) +
    hexField(Q.strength.encode(p.look.strength), 2) +
    hexField(Q.shift.encode(p.adjust.dx), 3) +
    hexField(Q.shift.encode(p.adjust.dy), 3) +
    hexField(Q.scale.encode(p.adjust.scale), 3) +
    hexField(Q.tilt.encode(p.adjust.rotationDeg), 3) +
    encodeReferenceFields(p).slice(0, 3 + 16) +
    hexField(indexOf(RESOLUTIONS, p.resolution), 1) +
    hexField(indexOf(BACKDROPS, p.backdrop), 1) +
    hexField(indexOf(VARIANTS, p.variant), 1)
  )
}

/** Inverse of `encodeFrameVersion` (quantized), or null for any other token. */
export function decodeFrameVersion(version: string): FrameRenderParams | null {
  if (version.length !== FRAME_LEN || !version.startsWith(TAG_FRAME) || !/^[0-9a-f]+$/.test(version)) {
    return null
  }
  const r = new Reader(version, 1 + HASH_LEN)
  const normalize = enumAt(NORMALIZE_MODES, r.next(1))
  const strength = round(r.next(2) / 100, 2)
  const adjust: FrameAdjust = {
    dx: round(r.next(3) / 4000 - 0.25, 5),
    dy: round(r.next(3) / 4000 - 0.25, 5),
    scale: round(r.next(3) / 2000 + 0.5, 4),
    rotationDeg: round(r.next(3) / 100 - 20, 2),
  }
  const rotationDeg = round(r.next(3) / 40 - 45, 3)
  const crop = { x: r.next(4), y: r.next(4), width: r.next(4), height: r.next(4) }
  const resolution = enumAt(RESOLUTIONS, r.next(1))
  const backdrop = enumAt(BACKDROPS, r.next(1))
  const variant = enumAt(VARIANTS, r.next(1))
  if (normalize === null || resolution === null || backdrop === null || variant === null) return null
  return { look: { normalize, strength }, adjust, rotationDeg, crop, resolution, backdrop, variant }
}

/* ─────────────── Reference versions ─────────────── */

const REFERENCE_FRAME_LEN = 1 + HASH_LEN + 3 + 16 + 1
const REFERENCE_IMAGE_LEN = 1 + HASH_LEN + 3 + 1

/** `ReferenceState.version` ('reference/frame' route): changes with rotation and crop. */
export function encodeReferenceFrameVersion(seed: string, p: ReferenceFrameParams): Version {
  return TAG_REFERENCE_FRAME + hashHex(`refFrame:${seed}`, HASH_LEN) + encodeReferenceFields(p)
}

export function decodeReferenceFrameVersion(version: string): ReferenceFrameParams | null {
  if (
    version.length !== REFERENCE_FRAME_LEN ||
    !version.startsWith(TAG_REFERENCE_FRAME) ||
    !/^[0-9a-f]+$/.test(version)
  ) {
    return null
  }
  return decodeReferenceFields(new Reader(version, 1 + HASH_LEN))
}

/** `ReferenceImage.version` ('reference' route): changes with the photo and its rotation. */
export function encodeReferenceImageVersion(seed: string, p: ReferenceImageParams): Version {
  return (
    TAG_REFERENCE_IMAGE +
    hashHex(`refImage:${seed}`, HASH_LEN) +
    hexField(Q.rotation.encode(p.rotationDeg), Q.rotation.width) +
    hexField(indexOf(VARIANTS, p.variant), 1)
  )
}

export function decodeReferenceImageVersion(version: string): ReferenceImageParams | null {
  if (
    version.length !== REFERENCE_IMAGE_LEN ||
    !version.startsWith(TAG_REFERENCE_IMAGE) ||
    !/^[0-9a-f]+$/.test(version)
  ) {
    return null
  }
  const r = new Reader(version, 1 + HASH_LEN)
  const rotationDeg = round(r.next(3) / 40 - 45, 3)
  const variant = enumAt(VARIANTS, r.next(1))
  return variant === null ? null : { rotationDeg, variant }
}
