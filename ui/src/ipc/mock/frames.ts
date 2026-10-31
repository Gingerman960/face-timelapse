// Aligned frames: render fingerprint, which masters are valid for the active
// days, FrameSummary (version, residual, adjust, lookDelta) and FramesView.
import type {
  DayGroup,
  FrameAdjust,
  FrameSummary,
  FramesStatus,
  FramesView,
  LookDelta,
  LookSettings,
  PhotoId,
  Point,
  Size,
  Version,
} from '../contract'
import { daysOf } from './days'
import { type FixturePhoto, portraitParams } from './fixtures'
import { outputSizeFor } from './geometry'
import { libraryOf } from './library'
import { clamp, hashHex, round, unitHash } from './random'
import { detectionOf } from './reference'
import { type FrameRecord, IDENTITY_ADJUST, type MockState, currentFolder, sameAdjust } from './state'
import { encodeFrameVersion } from './versions'

/** Share of frames whose residual is an outlier (> 3× the median). */
const OUTLIER_SHARE = 0.02
const MAX_LOOK_EV = 1.5
const MAX_COLOR_SHIFT = 6

export interface ActiveFrame {
  day: DayGroup
  photoId: PhotoId
  fixture: FixturePhoto
  record: FrameRecord | null
}

export interface FramesDerived {
  status: FramesStatus
  count: number
  expected: number
  outputSize: Size | null
  /** Active days in order, with their valid frame record (or null). */
  active: readonly ActiveFrame[]
  frames: readonly FrameSummary[]
}

/** Output pixel size for the current reference crop and render resolution. */
export function outputSizeOf(state: Pick<MockState, 'reference' | 'render'>): Size | null {
  const crop = state.reference?.crop
  return crop ? outputSizeFor(state.render.resolution, crop.width, crop.height) : null
}

/** Reference anchors normalized to the output frame (= the crop-normalized detection anchors). */
export function referenceAnchorsOf(state: Pick<MockState, 'reference'>): Point[] | null {
  return detectionOf(state.reference)?.anchors ?? null
}

/** blake3-like render fingerprint (§4.2), or null when there is nothing to align against. */
export function fingerprintOf(state: Pick<MockState, 'reference' | 'render'>): string | null {
  const ref = state.reference
  const detection = detectionOf(ref)
  const out = outputSizeOf(state)
  if (!ref || !detection || !out) return null
  return hashHex(
    JSON.stringify([
      'engine-2.0.0',
      ref.path,
      ref.rotationDeg,
      ref.crop,
      ref.aspect,
      detection.anchors,
      out,
      state.render.backdrop,
      state.render.refineLandmarks,
    ]),
    16,
  )
}

/** Deterministic RMS anchor error in output pixels; about 2 % are outliers above 3× the median. */
export function residualFor(photoId: PhotoId): number {
  const u = unitHash(`residual:${photoId}`)
  return unitHash(`outlier:${photoId}`) < OUTLIER_SHARE ? round(4.2 + u * 4.5, 2) : round(0.65 + u * 1.1, 2)
}

/** What the look does to this frame's face region (§9.6), null when the look is off. */
export function lookDeltaFor(photo: FixturePhoto, look: LookSettings): LookDelta | null {
  if (look.normalize === 'off') return null
  const params = portraitParams(photo.id, photo.takenAt)
  const exposureEv = round(clamp(-params.exposureEv * look.strength, -MAX_LOOK_EV, MAX_LOOK_EV), 2)
  const colorShift =
    look.normalize === 'exposureAndColor'
      ? round(clamp(Math.abs(params.warmth) * MAX_COLOR_SHIFT * look.strength, 0, MAX_COLOR_SHIFT), 2)
      : 0
  return { exposureEv, colorShift }
}

/** Frame version: content hash + packed render state for the mock image server. */
export function frameVersionOf(state: MockState, fingerprint: string, photoVersion: Version, adjust: FrameAdjust): Version {
  const ref = state.reference
  return encodeFrameVersion(`${fingerprint}|${photoVersion}|${JSON.stringify(adjust)}|${JSON.stringify(state.look)}`, {
    look: state.look,
    adjust,
    rotationDeg: ref?.rotationDeg ?? 0,
    crop: ref?.crop ?? { x: 0, y: 0, width: 0, height: 0 },
    resolution: state.render.resolution,
    backdrop: state.render.backdrop,
    variant: ref?.variant ?? 'portrait',
  })
}

export function frameSummaryOf(
  state: MockState,
  fingerprint: string,
  day: DayGroup,
  fixture: FixturePhoto,
  record: FrameRecord,
): FrameSummary {
  return {
    photoId: fixture.id,
    dayKey: day.dayKey,
    takenAt: fixture.takenAt,
    timeKnown: fixture.timeKnown,
    version: frameVersionOf(state, fingerprint, record.photoVersion, record.adjust),
    residualPx: record.residualPx,
    adjust: record.adjust,
    lookDelta: lookDeltaFor(fixture, state.look),
  }
}

/** The adjust the folder stores for `photoId` (identity by default). */
export function adjustOf(state: MockState, photoId: PhotoId): FrameAdjust {
  return currentFolder(state)?.decisions.adjusts[photoId] ?? IDENTITY_ADJUST
}

function statusOf(count: number, expected: number, hasStale: boolean): FramesStatus {
  if (expected > 0 && count === expected) return 'complete'
  if (count > 0) return 'partial'
  return hasStale ? 'stale' : 'none'
}

const cache = new WeakMap<MockState, FramesDerived>()

function buildFrames(state: MockState): FramesDerived {
  const folder = currentFolder(state)
  const library = libraryOf(folder)
  const fingerprint = fingerprintOf(state)
  const current = fingerprint === null ? undefined : state.frames[fingerprint]
  const others = Object.entries(state.frames)
    .filter(([fp]) => fp !== fingerprint)
    .map(([, records]) => records)
  const active: ActiveFrame[] = []
  let hasStale = false
  for (const day of daysOf(folder)) {
    if (day.excluded) continue
    const fixture = library.fixtures.get(day.selectedId)
    const summary = library.byId.get(day.selectedId)
    if (!fixture || !summary) continue
    const record = current?.[day.selectedId]
    const valid =
      record !== undefined &&
      record.photoVersion === summary.version &&
      sameAdjust(record.adjust, adjustOf(state, day.selectedId))
    if (!valid) hasStale ||= others.some((records) => records[day.selectedId] !== undefined)
    active.push({ day, photoId: day.selectedId, fixture, record: valid ? record : null })
  }
  const frames =
    fingerprint === null
      ? []
      : active.flatMap((a) => (a.record ? [frameSummaryOf(state, fingerprint, a.day, a.fixture, a.record)] : []))
  return {
    status: statusOf(frames.length, active.length, hasStale),
    count: frames.length,
    expected: active.length,
    outputSize: outputSizeOf(state),
    active,
    frames,
  }
}

/** Memoized per (immutable) state. */
export function framesOf(state: MockState): FramesDerived {
  const hit = cache.get(state)
  if (hit) return hit
  const derived = buildFrames(state)
  cache.set(state, derived)
  return derived
}

export function framesViewOf(state: MockState): FramesView {
  const derived = framesOf(state)
  return {
    status: derived.status,
    outputSize: derived.outputSize,
    render: state.render,
    look: state.look,
    referenceAnchors: referenceAnchorsOf(state),
    frames: [...derived.frames],
  }
}
