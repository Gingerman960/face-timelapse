// Synthetic library for the mock backend and the mock image server.
// Pure, deterministic (seeded) and environment-agnostic: the browser fake
// backend and the Node Vite middleware build exactly the same data.
import type {
  AspectPreset,
  DateSource,
  DayKey,
  FaceGeometry,
  LocalDateTime,
  MatchStatus,
  PhotoId,
  Rect,
  ReviewDecision,
  Size,
  Version,
} from '../contract'
import { LAST_DAY, type PlannedPhoto, planLibrary } from './calendar'
import { boxAt, faceInBox } from './faces'
import { type PortraitParams, portraitParams } from './people'
import { type Rng, hash32, hashHex, randRange, rngFor, round } from './random'

export { FIRST_DAY, LAST_DAY, REVIEW_SPOTLIGHT_AT, isValidDayKey } from './calendar'
export {
  REFERENCE_AUTO_ROTATION_DEG,
  REFERENCE_FACE,
  REFERENCE_SIZE,
  detectionFor,
  referenceGeometry,
  type ReferenceGeometry,
} from './faces'
export { portraitParams, type PortraitParams, type PersonRole } from './people'

/* ─────────────── Narrative constants ─────────────── */

export const DEMO_FOLDER = '/Users/demo/Pictures/Daily selfies'
export const DEMO_FOLDER_NAME = 'Daily selfies'
export const LIBRARY_SIZE = 3593
export const UNSUPPORTED_FILES: readonly string[] = ['IMG_20210911_093012.HEIC', 'IMG_20210912_084455.HEIC']
export const UNSUPPORTED_COUNT = UNSUPPORTED_FILES.length
export const STATUS_TOTALS: Readonly<Record<MatchStatus, number>> = {
  confirmed: 3529,
  uncertain: 41,
  rejected: 6,
  noFace: 17,
  failed: 0,
}

export const REFERENCE_DIR = '/Users/demo/Pictures/Reference'
export const REFERENCE_PATH = `${REFERENCE_DIR}/IMG_20140815_142326.jpg`
/** A reference candidate without a face (inline "no face" state). */
export const NO_FACE_REFERENCE_PATH = `${REFERENCE_DIR}/Window_no_face.jpg`
/** The crop of the restored session (3:4 → 1080×1440 at 1080p). */
export const RESTORED_CROP: Rect = { x: 746, y: 0, width: 1664, height: 2219 }
export const RESTORED_ASPECT: AspectPreset = '3:4'

/** Photos outside the folder that `add_photo_to_day` can add (the dialog offers them in order). */
export const EXTRAS_DIR = '/Users/demo/Pictures/Extras'
export const EXTRA_NO_FACE_PATH = `${EXTRAS_DIR}/Sunset_no_face.jpg`
const EXTRA_SPECS: readonly { fileName: string; takenAt: LocalDateTime; score: number }[] = [
  { fileName: 'IMG_20150704_101532.jpg', takenAt: '2015-07-04T10:15:32', score: 0.86 },
  { fileName: 'IMG_20190212_183005.jpg', takenAt: '2019-02-12T18:30:05', score: 0.81 },
  { fileName: 'IMG_20210530_074411.jpg', takenAt: '2021-05-30T07:44:11', score: 0.9 },
]

/** Calibration cut-offs (ARCHITECTURE §9.3) used to derive raw cosine similarity from a score. */
const COS_CONFIRMED = 0.363
const COS_UNCERTAIN = 0.2
const COS_ZERO = 2 * COS_UNCERTAIN - COS_CONFIRMED

/** Fixed scores for narrative photos, keyed by takenAt. */
const FIXED_SCORES: Readonly<Record<LocalDateTime, number>> = {
  '2014-05-02T00:41:12': 0.801,
  '2014-05-02T08:41:37': 0.912,
  '2014-05-02T12:23:05': 0.874,
  '2017-03-03T21:07:14': 0.47,
}
const FIXED_FACE_COUNTS: Readonly<Record<LocalDateTime, number>> = { '2017-03-03T21:07:14': 2 }
/** Share of confirmed photos dated from their file name (no EXIF date). */
const FILENAME_DATE_SHARE = 0.03
/** Share of those names that carry a date only (`IMG_20220827.jpg`, dated 00:00, no time of day). */
const DATE_ONLY_NAME_SHARE = 0.5
/** The day Days lands on: its photo has a date-only name, so the visual baselines show that case too. */
const DATE_ONLY_DAY: DayKey = LAST_DAY
const FILE_TIME_PHOTOS = 6

/* ─────────────── Types ─────────────── */

export interface FixturePhoto {
  id: PhotoId
  /** Absolute path. */
  path: string
  fileName: string
  /** Relative to the demo folder; absolute for photos outside it (extras). */
  relPath: string
  takenAt: LocalDateTime
  dateSource: Exclude<DateSource, 'manual'>
  /** Contract v1.4: EXIF or a timed file name; false for a date-only name (dated 00:00) or a file time. */
  timeKnown: boolean
  dayKey: DayKey
  score: number
  status: MatchStatus
  /** Uncertain photos only: the decision the `reviewed` scenario makes. */
  reviewOutcome: ReviewDecision | null
  size: Size
  /** Up to 3 faces, largest first. */
  faces: FaceGeometry[]
  matchedFace: number | null
  rawSimilarity: number | null
  /** Thumb version (8 hex). */
  version: Version
  /** Chronological index (= scan order); -1 for extras. */
  index: number
  /** Index of the subject's own face in `faces`; null when the subject isn't in the photo. */
  subjectFace: number | null
}

export interface Library {
  /** Chronological (scan order). */
  photos: readonly FixturePhoto[]
  /** relPath natural order (get_photos order). */
  byRelPath: readonly FixturePhoto[]
  byId: ReadonlyMap<PhotoId, FixturePhoto>
}

/* ─────────────── Ids and ordering ─────────────── */

/** 16 lowercase hex chars from the absolute path (stands in for blake3). */
export function photoIdFor(path: string): PhotoId {
  return hashHex(`photo:${path}`, 16)
}

/** 8 lowercase hex chars (stands in for blake3(size ‖ mtime)). */
export function photoVersionFor(path: string): Version {
  return hashHex(`version:${path}`, 8)
}

/** Natural sort (numeric runs compared by value), case-insensitive with a stable tie-break. */
export function naturalCompare(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? []
  const tb = b.match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i] as string
    const y = tb[i] as string
    const dx = /^\d/.test(x)
    const dy = /^\d/.test(y)
    if (dx && dy) {
      const nx = x.replace(/^0+(?=\d)/, '')
      const ny = y.replace(/^0+(?=\d)/, '')
      if (nx.length !== ny.length) return nx.length - ny.length
      if (nx !== ny) return nx < ny ? -1 : 1
    } else if (dx !== dy) {
      return dx ? -1 : 1
    } else {
      const lx = x.toLowerCase()
      const ly = y.toLowerCase()
      if (lx !== ly) return lx < ly ? -1 : 1
    }
  }
  if (ta.length !== tb.length) return ta.length - tb.length
  return a < b ? -1 : a > b ? 1 : 0
}

/** Raw cosine similarity that calibrates to `score` (inverse of §9.3). */
export function rawSimilarityFor(score: number): number {
  if (score >= 0.6) return round(COS_CONFIRMED + ((score - 0.6) / 0.4) * (1 - COS_CONFIRMED), 4)
  if (score >= 0.4) return round(COS_UNCERTAIN + ((score - 0.4) / 0.2) * (COS_CONFIRMED - COS_UNCERTAIN), 4)
  return round(COS_ZERO + (score / 0.4) * (COS_UNCERTAIN - COS_ZERO), 4)
}

/* ─────────────── Photo synthesis ─────────────── */

function compactDate(takenAt: LocalDateTime): string {
  return takenAt.slice(0, 10).replaceAll('-', '')
}

function compactTime(takenAt: LocalDateTime): string {
  return takenAt.slice(11, 19).replaceAll(':', '')
}

function scoreFor(status: MatchStatus, rng: Rng): number {
  const r = rng()
  switch (status) {
    case 'confirmed':
      return round(r < 0.05 ? 0.6 + rng() * 0.06 : 0.66 + Math.sqrt(rng()) * 0.31, 3)
    case 'uncertain':
      return round(0.4 + r * 0.19, 3)
    case 'rejected':
      return round(0.05 + r * 0.33, 3)
    default:
      return 0
  }
}

function faceCountFor(status: MatchStatus, rng: Rng): number {
  const r = rng()
  if (status === 'noFace' || status === 'failed') return 0
  if (status === 'confirmed') return r < 0.05 ? 2 : r < 0.06 ? 3 : 1
  return r < 0.45 ? 2 : 1
}

interface Placed {
  face: FaceGeometry
  area: number
  isMain: boolean
}

/** Main face roughly centred; companions to its left/right, a bit smaller. */
function placeFaces(count: number, size: Size, rng: Rng): Placed[] {
  const mainWidth = randRange(rng, 0.18, 0.3) * size.width
  const mainCx = randRange(rng, 0.4, 0.6) * size.width
  const eyeY = randRange(rng, 0.33, 0.45) * size.height
  const mainBox = boxAt(mainCx, eyeY, mainWidth, size)
  const placed: Placed[] = [
    {
      face: faceInBox(mainBox, size, randRange(rng, -6, 6), randRange(rng, 0.9, 0.99), rng),
      area: mainBox.width * mainBox.height,
      isMain: true,
    },
  ]
  for (let i = 1; i < count; i++) {
    const width = mainWidth * randRange(rng, 0.6, 0.9)
    const side = i % 2 === 1 ? -1 : 1
    const cx = mainCx + side * (mainWidth / 2 + width / 2 + size.width * 0.03)
    const box = boxAt(cx, eyeY + randRange(rng, -0.05, 0.05) * size.height, width, size)
    placed.push({
      face: faceInBox(box, size, randRange(rng, -8, 8), randRange(rng, 0.72, 0.95), rng),
      area: box.width * box.height,
      isMain: false,
    })
  }
  return placed.sort((a, b) => b.area - a.area)
}

function sizeFor(takenAt: LocalDateTime, rng: Rng): Size {
  const landscape = takenAt < '2015' ? { width: 3264, height: 2448 } : { width: 4032, height: 3024 }
  return rng() < 0.08 ? { width: landscape.height, height: landscape.width } : landscape
}

function fileNameFor(takenAt: LocalDateTime, dated: Dated, rng: Rng): string {
  if (dated.dateSource === 'fileTime') {
    return `FB_IMG_${Date.parse(`${takenAt}Z`) + Math.floor(rng() * 1000)}.jpg`
  }
  const stamp = dated.timeKnown ? `${compactDate(takenAt)}_${compactTime(takenAt)}` : compactDate(takenAt)
  return takenAt < '2014' ? `${stamp}.jpg` : `IMG_${stamp}.jpg`
}

function canVaryDateSource(plan: PlannedPhoto, takenAt: LocalDateTime): boolean {
  return plan.status === 'confirmed' && !(takenAt in FIXED_SCORES) && !takenAt.startsWith('2014-08-15')
}

/** Six confirmed photos without EXIF or a dated name: their date comes from the file time. */
function chooseFileTimePhotos(plans: readonly PlannedPhoto[]): ReadonlySet<number> {
  const candidates = plans
    .map((plan, index) => ({ index, key: hash32(`fileTime:${plan.dayKey}T${plan.time}`) }))
    .filter(({ index }) => {
      const plan = plans[index] as PlannedPhoto
      return canVaryDateSource(plan, `${plan.dayKey}T${plan.time}`)
    })
    .sort((a, b) => a.key - b.key)
  return new Set(candidates.slice(0, FILE_TIME_PHOTOS).map((c) => c.index))
}

/** Where a photo's date comes from, and whether that source has a time of day. */
type Dated = Pick<FixturePhoto, 'dateSource' | 'timeKnown'>

function datedFor(plan: PlannedPhoto, takenAt: LocalDateTime, fileTime: boolean, rng: Rng): Dated {
  const r = rng()
  if (fileTime) return { dateSource: 'fileTime', timeKnown: false }
  if (!canVaryDateSource(plan, takenAt)) return { dateSource: 'exif', timeKnown: true }
  if (plan.dayKey === DATE_ONLY_DAY) return { dateSource: 'filename', timeKnown: false }
  if (r >= FILENAME_DATE_SHARE) return { dateSource: 'exif', timeKnown: true }
  return { dateSource: 'filename', timeKnown: rng() >= DATE_ONLY_NAME_SHARE }
}

interface PhotoSeed extends Dated {
  takenAt: LocalDateTime
  status: MatchStatus
  reviewOutcome: ReviewDecision | null
  fileName: string
  relPath: string
  path: string
  index: number
  fixedScore?: number
}

function buildPhoto(seed: PhotoSeed): FixturePhoto {
  const rng = rngFor(`fixture:${seed.path}`)
  const size = sizeFor(seed.takenAt, rng)
  const score = seed.fixedScore ?? FIXED_SCORES[seed.takenAt] ?? scoreFor(seed.status, rng)
  const count = FIXED_FACE_COUNTS[seed.takenAt] ?? faceCountFor(seed.status, rng)
  const placed = count > 0 ? placeFaces(count, size, rng) : []
  const mainIndex = placed.findIndex((p) => p.isMain)
  const hasMatch = placed.length > 0
  const subjectInPhoto = seed.status === 'confirmed' || seed.status === 'uncertain'
  return {
    id: photoIdFor(seed.path),
    path: seed.path,
    fileName: seed.fileName,
    relPath: seed.relPath,
    takenAt: seed.takenAt,
    dateSource: seed.dateSource,
    timeKnown: seed.timeKnown,
    dayKey: seed.takenAt.slice(0, 10),
    score,
    status: seed.status,
    reviewOutcome: seed.reviewOutcome,
    size,
    faces: placed.map((p) => p.face),
    matchedFace: hasMatch ? mainIndex : null,
    rawSimilarity: hasMatch ? rawSimilarityFor(score) : null,
    version: photoVersionFor(seed.path),
    index: seed.index,
    subjectFace: subjectInPhoto && hasMatch ? mainIndex : null,
  }
}

function buildLibrary(): Library {
  const plans = planLibrary()
  const fileTimePhotos = chooseFileTimePhotos(plans)
  const photos = plans.map((plan, index) => {
    const plannedAt = `${plan.dayKey}T${plan.time}`
    const rng = rngFor(`name:${plannedAt}:${index}`)
    const dated = datedFor(plan, plannedAt, fileTimePhotos.has(index), rng)
    // A date-only name dates the photo at midnight, as the backend does.
    const takenAt = dated.dateSource === 'filename' && !dated.timeKnown ? `${plan.dayKey}T00:00:00` : plannedAt
    const fileName = fileNameFor(takenAt, dated, rng)
    const relPath = takenAt.startsWith('2016-') ? `2016/${fileName}` : fileName
    return buildPhoto({
      takenAt,
      status: plan.status,
      reviewOutcome: plan.reviewOutcome,
      ...dated,
      fileName,
      relPath,
      path: `${DEMO_FOLDER}/${relPath}`,
      index,
    })
  })
  const byRelPath = photos.slice().sort((a, b) => naturalCompare(a.relPath, b.relPath))
  return { photos, byRelPath, byId: new Map(photos.map((p) => [p.id, p])) }
}

function buildExtras(): FixturePhoto[] {
  return EXTRA_SPECS.map((spec) => {
    const path = `${EXTRAS_DIR}/${spec.fileName}`
    return buildPhoto({
      takenAt: spec.takenAt,
      status: 'confirmed',
      reviewOutcome: null,
      dateSource: 'exif',
      timeKnown: true,
      fileName: spec.fileName,
      relPath: path,
      path,
      index: -1,
      fixedScore: spec.score,
    })
  })
}

/* ─────────────── Lazily built singletons ─────────────── */

let libraryCache: Library | null = null
let extrasCache: readonly FixturePhoto[] | null = null

/** The 3,593-photo demo library (built once, ~10 ms). */
export function demoLibrary(): Library {
  libraryCache ??= buildLibrary()
  return libraryCache
}

/** Photos outside the folder that can be added to a day manually. */
export function extraPhotos(): readonly FixturePhoto[] {
  extrasCache ??= buildExtras()
  return extrasCache
}

/** Any fixture photo (library or extra) by id. */
export function fixturePhoto(id: PhotoId): FixturePhoto | undefined {
  return demoLibrary().byId.get(id) ?? extraPhotos().find((p) => p.id === id)
}

/** Any fixture photo (library or extra) by absolute path. */
export function fixturePhotoByPath(path: string): FixturePhoto | undefined {
  return fixturePhoto(photoIdFor(path))
}

/** Per-photo geometry lookup by id (faces normalized to the oriented photo). */
export function photoGeometry(id: PhotoId): { size: Size; faces: FaceGeometry[]; matchedFace: number | null } | null {
  const photo = fixturePhoto(id)
  return photo ? { size: photo.size, faces: photo.faces, matchedFace: photo.matchedFace } : null
}

/** The library photo the reference is a copy of (same file name and moment). */
export function referenceTwin(): FixturePhoto | undefined {
  return demoLibrary().photos.find((p) => p.fileName === 'IMG_20140815_142326.jpg')
}

/** Appearance of the reference photo: the twin's look, neutral exposure (it is the target). */
export function referencePortraitParams(): PortraitParams {
  const twin = referenceTwin()
  const base = portraitParams(twin?.id ?? 'reference', twin?.takenAt ?? '2014-08-15T14:23:26')
  return { ...base, beard: 0, exposureEv: 0, warmth: 0 }
}
