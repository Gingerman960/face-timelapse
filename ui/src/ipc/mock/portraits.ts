// SVG stand-ins for the mock image routes. Synthetic portraits only: a muted
// room, shirt, head, hair, a beard that grows over the decade, and subtle
// eye/mouth shading — never facial features beyond that.
//
// Faces are drawn from the fixture anchors, so a CSS face crop (faceBox) or a
// client-side Procrustes transform lines up with what is drawn.
import type { Point, Size } from '../contract'
import { type Affine, adjustAffine, composeAffine, outputSizeFor, procrustes, rotatedSize } from './geometry'
import { REFERENCE_FACE, REFERENCE_SIZE, anchorsPx, detectionFor, referenceGeometry } from './faces'
import { type FixturePhoto, RESTORED_CROP, fixturePhoto, referencePortraitParams } from './fixtures'
import { type PortraitParams, portraitParams } from './people'
import { clamp, round } from './random'
import {
  type FrameRenderParams,
  type ReferenceFrameParams,
  type ReferenceImageParams,
  decodeFrameVersion,
  decodeReferenceFrameVersion,
  decodeReferenceImageVersion,
} from './versions'

export type MockImageRoute = 'thumb' | 'aligned' | 'reference' | 'referenceFrame'

/** Largest rendered edge when no `w` is given. */
export const MAX_NATURAL_WIDTH = 2048

/** Render parameters of the restored session (used when a route has no decodable `v`). */
export const DEFAULT_FRAME_PARAMS: FrameRenderParams = {
  look: { normalize: 'off', strength: 0.7 },
  adjust: { dx: 0, dy: 0, scale: 1, rotationDeg: 0 },
  rotationDeg: 0,
  crop: RESTORED_CROP,
  resolution: '1080p',
  backdrop: 'extended',
  variant: 'portrait',
}

const DEFAULT_IMAGE_PARAMS: ReferenceImageParams = { rotationDeg: 0, variant: 'portrait' }

/* ─────────────── Head template (face units: eyes at (−0.5, 0) and (0.5, 0)) ─────────────── */

const HEAD = { cx: -0.016, cy: 0.469, rx: 0.824, ry: 1.273 }

const f1 = (x: number) => String(round(x, 1))
const f3 = (x: number) => String(round(x, 3))

function hairPath(): string {
  const { cx, cy, rx, ry } = HEAD
  const p = (kx: number, ky: number) => `${f3(cx + kx * rx)} ${f3(cy + ky * ry)}`
  return (
    `M${p(-1.05, -0.25)} C${p(-1.12, -1.32)} ${p(1.12, -1.36)} ${p(1.05, -0.25)} ` +
    `C${p(0.75, -0.95)} ${p(-0.75, -0.95)} ${p(-1.05, -0.25)}Z`
  )
}

function beardPath(): string {
  const { cx, cy, rx, ry } = HEAD
  const p = (kx: number, ky: number) => `${f3(cx + kx * rx)} ${f3(cy + ky * ry)}`
  return (
    `M${p(-0.97, 0.18)} C${p(-0.9, 1.22)} ${p(0.9, 1.22)} ${p(0.97, 0.18)} ` +
    `C${p(0.6, 0.5)} ${p(-0.6, 0.5)} ${p(-0.97, 0.18)}Z`
  )
}

const HAIR_PATH = hairPath()
const BEARD_PATH = beardPath()
const SHIRT_PATH = 'M-2.6 14 L-2.2 3.3 C-2.1 2.45 -1.3 2.05 -0.5 1.98 L0.5 1.98 C1.3 2.05 2.1 2.45 2.2 3.3 L2.6 14Z'

export interface ScenePerson {
  /** Five anchors in scene pixels: [leftEye, rightEye, noseTip, mouthLeft, mouthRight]. */
  anchors: readonly Point[]
  look: PortraitParams
}

interface Scene {
  size: Size
  params: PortraitParams
  people: readonly ScenePerson[]
  /** Exposure baked into the picture, in stops. */
  exposureEv: number
  /** White balance baked into the picture, −1..1. */
  warmth: number
}

function personMarkup(person: ScenePerson, index: number): string {
  const [le, re, , ml, mr] = person.anchors
  if (!le || !re || !ml || !mr) return ''
  const mid = { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 }
  const ipd = Math.hypot(re.x - le.x, re.y - le.y)
  const angle = Math.atan2(re.y - le.y, re.x - le.x)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const mouth = { x: (ml.x + mr.x) / 2 - mid.x, y: (ml.y + mr.y) / 2 - mid.y }
  const mx = (mouth.x * cos + mouth.y * sin) / ipd
  const my = (-mouth.x * sin + mouth.y * cos) / ipd
  const mouthWidth = Math.hypot(mr.x - ml.x, mr.y - ml.y) / ipd
  const { skin, hair, shirt, beard } = person.look
  const shade = `p${index}`
  const head = `cx="${HEAD.cx}" cy="${HEAD.cy}" rx="${HEAD.rx}" ry="${HEAD.ry}"`
  return (
    `<g transform="matrix(${f3(cos * ipd)} ${f3(sin * ipd)} ${f3(-sin * ipd)} ${f3(cos * ipd)} ${f1(mid.x)} ${f1(mid.y)})">` +
    `<radialGradient id="${shade}" cx="42%" cy="36%" r="70%"><stop offset="0" stop-color="#fff" stop-opacity=".2"/>` +
    `<stop offset="1" stop-color="#000" stop-opacity=".2"/></radialGradient>` +
    `<path d="${SHIRT_PATH}" fill="${shirt}"/>` +
    `<rect x="-0.36" y="1.2" width="0.72" height="1.1" fill="${skin}"/>` +
    `<ellipse cx="0" cy="1.66" rx="0.5" ry="0.16" fill="#000" opacity=".1"/>` +
    `<ellipse cx="-0.83" cy="0.33" rx="0.1" ry="0.22" fill="${skin}"/>` +
    `<ellipse cx="0.8" cy="0.33" rx="0.1" ry="0.22" fill="${skin}"/>` +
    `<ellipse ${head} fill="${skin}"/><ellipse ${head} fill="url(#${shade})"/>` +
    `<path d="${HAIR_PATH}" fill="${hair}"/>` +
    (beard > 0 ? `<path d="${BEARD_PATH}" fill="${hair}" opacity="${f3(beard * 0.85)}"/>` : '') +
    `<g fill="#241a14" opacity=".32"><ellipse cx="-0.5" cy="0" rx="0.15" ry="0.06"/><ellipse cx="0.5" cy="0" rx="0.15" ry="0.06"/></g>` +
    `<ellipse cx="${f3(mx)}" cy="${f3(my)}" rx="${f3(mouthWidth * 0.45)}" ry="0.055" fill="#5b2a26" opacity=".28"/>` +
    `</g>`
  )
}

function roomMarkup(scene: Scene): string {
  const { width: w, height: h } = scene.size
  const p = scene.params
  const picture =
    p.featureX < 0.5
      ? `<rect x="${f1(w * 0.74)}" y="${f1(h * 0.1)}" width="${f1(w * 0.13)}" height="${f1(h * 0.17)}" fill="${p.trim}" opacity=".3"/>`
      : `<rect x="${f1(w * 0.06)}" y="${f1(h * 0.55)}" width="${f1(w * 0.2)}" height="${f1(h * 0.025)}" fill="${p.trim}" opacity=".45"/>`
  return (
    `<rect width="${w}" height="${h}" fill="${p.room}"/>` +
    `<rect x="${f1(w * p.featureX)}" y="0" width="${f1(w * 0.05)}" height="${h}" fill="${p.trim}" opacity=".35"/>` +
    picture +
    `<rect width="${w}" height="${h}" fill="url(#light)"/>`
  )
}

function emptyRoomProps(scene: Scene): string {
  const { width: w, height: h } = scene.size
  return (
    `<rect x="${f1(w * 0.12)}" y="${f1(h * 0.62)}" width="${f1(w * 0.72)}" height="${f1(h * 0.4)}" rx="${f1(w * 0.03)}" fill="#4e463f"/>` +
    `<rect x="${f1(w * 0.16)}" y="${f1(h * 0.58)}" width="${f1(w * 0.3)}" height="${f1(h * 0.12)}" rx="${f1(w * 0.02)}" fill="#5d544b"/>` +
    `<circle cx="${f1(w * 0.82)}" cy="${f1(h * 0.3)}" r="${f1(w * 0.05)}" fill="#efe1c2" opacity=".75"/>`
  )
}

function lightingMarkup(scene: Scene): string {
  const { width: w, height: h } = scene.size
  const ev = scene.exposureEv
  const exposure =
    ev >= 0
      ? `<rect width="${w}" height="${h}" fill="#fff" opacity="${f3(Math.min(0.4, ev * 0.18))}"/>`
      : `<rect width="${w}" height="${h}" fill="#000" opacity="${f3(Math.min(0.45, -ev * 0.2))}"/>`
  const tint = scene.warmth >= 0 ? '#ff9b42' : '#4f86ff'
  return (
    `<rect width="${w}" height="${h}" fill="url(#vignette)"/>` +
    exposure +
    `<rect width="${w}" height="${h}" fill="${tint}" opacity="${f3(Math.abs(scene.warmth) * 0.07)}"/>`
  )
}

/** `<defs>` with the scene as `#s` (drawn in scene pixels) plus shared gradients. */
function sceneDefs(scene: Scene): string {
  const p = scene.params
  const people = scene.people.map((person, i) => personMarkup(person, i)).join('')
  return (
    `<defs>` +
    `<radialGradient id="light" cx="${f3(p.lightX)}" cy="0.18" r="0.85"><stop offset="0" stop-color="#fff" stop-opacity="${f3(p.lightStrength)}"/>` +
    `<stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="vignette" cx="0.5" cy="0.45" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="#000" stop-opacity=".3"/></radialGradient>` +
    `<filter id="blur" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${f1(scene.size.width * 0.012)}"/></filter>` +
    `<g id="s">${roomMarkup(scene)}${people.length > 0 ? people : emptyRoomProps(scene)}${lightingMarkup(scene)}</g>` +
    `</defs>`
  )
}

function svgDocument(width: number, height: number, viewBox: string, content: string, extra = ''): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}"${extra}>` +
    content +
    `</svg>`
  )
}

const matrix = (m: Affine) => `matrix(${[m.a, m.b, m.c, m.d].map(f3).join(' ')} ${f1(m.e)} ${f1(m.f)})`

/* ─────────────── Scenes per route ─────────────── */

function photoScene(photo: FixturePhoto, exposureFactor = 1, warmthFactor = 1): Scene {
  const params = portraitParams(photo.id, photo.takenAt, 'subject')
  const people = photo.faces.map((face, i) => ({
    anchors: anchorsPx(face, photo.size),
    look: i === photo.subjectFace ? params : portraitParams(`${photo.id}#${i}`, photo.takenAt, 'other'),
  }))
  return {
    size: photo.size,
    params,
    people,
    exposureEv: params.exposureEv * exposureFactor,
    warmth: params.warmth * warmthFactor,
  }
}

function referenceScene(hasFace: boolean): Scene {
  const params = referencePortraitParams()
  const people = hasFace ? [{ anchors: anchorsPx(REFERENCE_FACE, REFERENCE_SIZE), look: params }] : []
  return { size: REFERENCE_SIZE, params, people, exposureEv: 0, warmth: 0 }
}

/** Long edge = w (thumb semantics: fit inside w×w). */
function fitInside(size: Size, w: number | null): Size {
  const edge = clamp(Math.round(w ?? Math.min(MAX_NATURAL_WIDTH, Math.max(size.width, size.height))), 1, 8192)
  return size.width >= size.height
    ? { width: edge, height: Math.max(1, Math.round((edge * size.height) / size.width)) }
    : { width: Math.max(1, Math.round((edge * size.width) / size.height)), height: edge }
}

/** Width = w, height from the aspect. */
function byWidth(size: Size, w: number | null): Size {
  const width = clamp(Math.round(w ?? Math.min(MAX_NATURAL_WIDTH, size.width)), 1, 8192)
  return { width, height: Math.max(1, Math.round((width * size.height) / size.width)) }
}

function renderThumb(photo: FixturePhoto, w: number | null): string {
  const scene = photoScene(photo)
  const out = fitInside(photo.size, w)
  return svgDocument(out.width, out.height, `0 0 ${photo.size.width} ${photo.size.height}`, `${sceneDefs(scene)}<use href="#s"/>`)
}

/** The rotated reference canvas content (black fill outside the photo). */
function rotatedReference(params: ReferenceFrameParams): { size: Size; defs: string; body: string } {
  const scene = referenceScene(params.variant === 'portrait')
  const size = rotatedSize(REFERENCE_SIZE, params.rotationDeg)
  const body =
    `<rect width="${size.width}" height="${size.height}" fill="#000"/>` +
    `<use href="#s" transform="translate(${f1(size.width / 2)} ${f1(size.height / 2)}) rotate(${f3(params.rotationDeg)}) ` +
    `translate(${f1(-REFERENCE_SIZE.width / 2)} ${f1(-REFERENCE_SIZE.height / 2)})"/>`
  return { size, defs: sceneDefs(scene), body }
}

function renderReference(version: string | null, w: number | null): string {
  const image = (version ? decodeReferenceImageVersion(version) : null) ?? DEFAULT_IMAGE_PARAMS
  const ref = rotatedReference({ ...image, crop: RESTORED_CROP })
  const out = byWidth(ref.size, w)
  return svgDocument(out.width, out.height, `0 0 ${ref.size.width} ${ref.size.height}`, ref.defs + ref.body)
}

function renderReferenceFrame(version: string | null, w: number | null): string {
  const params = (version ? decodeReferenceFrameVersion(version) : null) ?? DEFAULT_FRAME_PARAMS
  const ref = rotatedReference(params)
  const { crop } = params
  const out = outputSizeFor('1080p', crop.width, crop.height) ?? { width: 1080, height: 1440 }
  const px = byWidth(out, w)
  return svgDocument(
    px.width,
    px.height,
    `${crop.x} ${crop.y} ${crop.width} ${crop.height}`,
    ref.defs + ref.body,
    ' preserveAspectRatio="none"',
  )
}

/** Source photo → output frame transform for the given render parameters. */
export function alignedTransform(photo: FixturePhoto, params: FrameRenderParams): { out: Size; transform: Affine } {
  const geometry = referenceGeometry(params.rotationDeg, params.variant === 'portrait')
  const out = outputSizeFor(params.resolution, params.crop.width, params.crop.height) ?? { width: 1080, height: 1440 }
  const detection = detectionFor(geometry, params.crop)
  const face = photo.matchedFace === null ? undefined : photo.faces[photo.matchedFace]
  const base =
    detection && face
      ? procrustes(
          anchorsPx(face, photo.size),
          detection.anchors.map((a) => ({ x: a.x * out.width, y: a.y * out.height })),
        )
      : coverTransform(photo.size, out)
  return { out, transform: composeAffine(adjustAffine(params.adjust, out), base) }
}

function coverTransform(src: Size, out: Size): Affine {
  const s = Math.max(out.width / src.width, out.height / src.height)
  return { a: s, b: 0, c: 0, d: s, e: (out.width - src.width * s) / 2, f: (out.height - src.height * s) / 2 }
}

function renderAligned(photo: FixturePhoto, version: string | null, w: number | null): string {
  const params = (version ? decodeFrameVersion(version) : null) ?? DEFAULT_FRAME_PARAMS
  const { normalize, strength } = params.look
  const exposureFactor = normalize === 'off' ? 1 : 1 - strength
  const warmthFactor = normalize === 'exposureAndColor' ? 1 - strength : 1
  const scene = photoScene(photo, exposureFactor, warmthFactor)
  const { out, transform } = alignedTransform(photo, params)
  const cover = matrix(coverTransform(photo.size, out))
  const backdrop =
    params.backdrop === 'black'
      ? `<rect width="${out.width}" height="${out.height}" fill="#000"/>`
      : params.backdrop === 'blurred'
        ? `<g filter="url(#blur)"><use href="#s" transform="${cover}"/></g><rect width="${out.width}" height="${out.height}" fill="#000" opacity=".4"/>`
        : params.backdrop === 'extended'
          ? `<g filter="url(#blur)"><use href="#s" transform="${cover}"/></g>`
        : `<use href="#s" transform="${cover}"/><rect width="${out.width}" height="${out.height}" fill="#000" opacity=".55"/>`
  const px = byWidth(out, w)
  return svgDocument(
    px.width,
    px.height,
    `0 0 ${out.width} ${out.height}`,
    `${sceneDefs(scene)}${backdrop}<use href="#s" transform="${matrix(transform)}"/>`,
  )
}

/**
 * Deterministic SVG for a mock image route, or null when `id` is unknown.
 * `w` follows the protocol: long edge for `thumb`, width for the others,
 * null ⇒ natural size capped at 2048. `version` carries the render state
 * (see versions.ts); without it the restored-session defaults are drawn.
 */
export function renderMockSvg(
  route: MockImageRoute,
  id: string | null,
  w: number | null,
  version: string | null = null,
): string | null {
  switch (route) {
    case 'reference':
      return renderReference(version, w)
    case 'referenceFrame':
      return renderReferenceFrame(version, w)
    case 'thumb':
    case 'aligned': {
      const photo = id === null ? undefined : fixturePhoto(id)
      if (!photo) return null
      return route === 'thumb' ? renderThumb(photo, w) : renderAligned(photo, version, w)
    }
  }
}
