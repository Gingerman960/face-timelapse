// ui/src/ipc/contract.ts
// BINDING IPC CONTRACT — copied verbatim from docs/rewrite/ARCHITECTURE.md §7.3.
// Rust mirror: src-tauri/src/ipc.rs. Change the doc first, then both files.
import type { Channel } from '@tauri-apps/api/core'

/* ───────────────────────── Scalars ───────────────────────── */
/** 16 lowercase hex chars: blake3(canonical absolute path). Stable across launches. */
export type PhotoId = string
/** Opaque job id, unique per app run. */
export type JobId = string
/** Calendar day 'YYYY-MM-DD'. */
export type DayKey = string
/** Wall-clock local time without offset: 'YYYY-MM-DDTHH:MM:SS'. */
export type LocalDateTime = string
/** Opaque cache-busting token (lowercase hex). */
export type Version = string

export interface Point { x: number; y: number }
/** Pixel size. */
export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

/* ───────────────────────── Errors ───────────────────────── */
export type ErrorKind =
  | 'noFaceInReference'
  | 'noFaceDetected'
  | 'notFound'
  | 'invalidArgument'
  | 'unsupportedFormat'
  | 'decodeFailed'
  | 'permissionDenied'
  | 'diskFull'
  | 'io'
  | 'busy'
  | 'cancelled'
  | 'notReady'
  | 'modelUnavailable'
  | 'encodeFailed'
  | 'internal'

/** Every command rejects with exactly this shape. `message` is user-facing. */
export interface IpcError { kind: ErrorKind; message: string }

/* ───────────────────────── App ───────────────────────── */
export type Platform = 'macos' | 'windows' | 'linux'

export interface AppInfo {
  version: string
  platform: Platform
  /** Image protocol base, ends with '/': 'ftimg://localhost/' or 'http://ftimg.localhost/' (Windows). */
  imageBaseUrl: string
  modelsReady: boolean
  /** v1.6: why the background model load failed (user-facing); null while loading and once ready. */
  modelsError: string | null
  /** Worker threads used by jobs. */
  parallelism: number
  dataDir: string
  cacheDir: string
}

/* ───────────────────────── Reference ───────────────────────── */
export type AspectPreset = 'free' | '1:1' | '4:3' | '3:4' | '4:5' | '16:9' | '9:16'

/** Normalized [0,1] to its image. anchors: [leftEye, rightEye, noseTip, mouthLeft, mouthRight] (image left/right). */
export interface FaceGeometry {
  bounds: Rect
  anchors: Point[]
  confidence: number
}

export interface ReferenceImage {
  path: string
  fileName: string
  /** Clockwise degrees applied after EXIF orientation, [-45, 45]; canvas expands, black fill. */
  rotationDeg: number
  /** Rotation that levels the eyes (-atan2(dy, dx) in degrees); null if no face. Apply only if |v| > 0.3. */
  autoRotationDeg: number | null
  /** Pixel size after orientation + rotation; crop coordinates live in this space. */
  size: Size
  /** Largest face in the whole rotated image (for "Center face"); normalized to `size`. */
  face: FaceGeometry | null
  /** Version for the `reference` image route. */
  version: Version
}

export interface ReferenceDetection {
  /** 5 anchors normalized to the crop. */
  anchors: Point[]
  /** Face bounds normalized to the crop. */
  faceBox: Rect
  confidence: number
}

export interface ReferenceState {
  image: ReferenceImage
  /** Pixels in `image.size` space. */
  crop: Rect
  aspect: AspectPreset
  /** null ⇒ no face inside the crop: show an inline hint; scan/align are disabled. */
  detection: ReferenceDetection | null
  /** Version for the `reference/frame` route (changes with rotation/crop). */
  version: Version
}

/* ───────────────────────── Folder & library ───────────────────────── */
export interface FolderInfo {
  path: string
  name: string
  /** Supported image files found (recursive). */
  imageCount: number
  /** Files with a valid cached analysis. */
  analyzedCount: number
  /** Files skipped for their format (e.g. .heic). */
  unsupportedCount: number
}

export type CacheScope = 'folder' | 'all'
export interface ClearCacheResult { removedEntries: number; freedBytes: number }

export type MatchStatus = 'confirmed' | 'uncertain' | 'rejected' | 'noFace' | 'failed'
export type ReviewDecision = 'pending' | 'confirmed' | 'rejected'
export type DateSource = 'exif' | 'filename' | 'fileTime' | 'manual'

export interface PhotoSummary {
  id: PhotoId
  fileName: string
  /** Relative to the source folder; absolute for manually added photos outside it. */
  relPath: string
  takenAt: LocalDateTime
  dateSource: DateSource
  /** v1.4: takenAt has a real time of day (EXIF, or a file name with a time). False for file times, date-only names and hand-added photos: show the date only. */
  timeKnown: boolean
  /** Effective day (after user moves). */
  dayKey: DayKey
  /** Calibrated [0,1]; >= 0.60 confirmed, >= 0.40 uncertain. 0 for noFace/failed. */
  score: number
  status: MatchStatus
  review: ReviewDecision
  /** In the day pool: review === 'confirmed' || (review === 'pending' && status === 'confirmed'). */
  included: boolean
  /** Oriented pixel size. */
  size: Size
  /** Bounds of the matched face, normalized [0,1] to the oriented image; null for noFace/failed. */
  faceBox: Rect | null
  version: Version
}

export interface PhotoDetail {
  summary: PhotoSummary
  path: string
  /** Up to 3 faces, normalized to the photo. */
  faces: FaceGeometry[]
  /** Index into `faces` of the face matched to the reference. */
  matchedFace: number | null
  /** Raw cosine similarity of the matched face. */
  rawSimilarity: number | null
  /** v1.7: `v` of the preview route (the aligned frame this photo would get now); null without a matched face or a reference face. */
  previewVersion: Version | null
}

export interface PhotoQuery {
  /** null ⇒ all photos. */
  statuses: MatchStatus[] | null
}

export interface LibraryCounts {
  total: number
  confirmed: number
  uncertain: number
  rejected: number
  noFace: number
  failed: number
  /** Uncertain photos still awaiting a decision. */
  reviewPending: number
  included: number
  /** Day groups, including excluded days. */
  days: number
  /** Non-excluded days = frames to align. */
  activeDays: number
}

/* ───────────────────────── Jobs (shared) ───────────────────────── */
export type JobKind = 'scan' | 'align' | 'exportImages' | 'exportVideo'
export interface ActiveJob { jobId: JobId; kind: JobKind }
export interface JobStarted { jobId: JobId; total: number }
export interface JobFailed { jobId: JobId; error: IpcError }
export interface JobCancelled { jobId: JobId; done: number }

/* ───────────────────────── Scan ───────────────────────── */
export interface ScanProgress {
  jobId: JobId
  done: number
  total: number
  fromCache: number
  analyzed: number
  confirmed: number
  uncertain: number
  rejected: number
  noFace: number
  failed: number
  currentFile: string | null
  photosPerSecond: number
  etaMs: number | null
  /** Confirmed/uncertain photos finished since the previous event (max 64), for the live mosaic. */
  recent: ScanRecent[]
}

/** Enough to render a mosaic tile without a round trip: thumb URL = thumb/{id}?v={version}. */
export interface ScanRecent {
  id: PhotoId
  /** Photo version (thumb route). */
  version: Version
  dayKey: DayKey
  status: 'confirmed' | 'uncertain'
}

export interface ScanSummary {
  jobId: JobId
  total: number
  fromCache: number
  analyzed: number
  confirmed: number
  uncertain: number
  rejected: number
  noFace: number
  failed: number
  durationMs: number
}

export type ScanEvent =
  | ({ type: 'started' } & JobStarted)
  | ({ type: 'progress' } & ScanProgress)
  | ({ type: 'finished' } & ScanSummary)
  | ({ type: 'failed' } & JobFailed)
  | ({ type: 'cancelled' } & JobCancelled)

/* ───────────────────────── Days ───────────────────────── */
export interface DayGroup {
  dayKey: DayKey
  /** Included photos of the day, score desc, then takenAt asc. Never empty. */
  photoIds: PhotoId[]
  selectedId: PhotoId
  autoSelectedId: PhotoId
  /** True when selectedId was chosen by the user. */
  manualSelection: boolean
  excluded: boolean
}

export interface DaysPatch { upserted: DayGroup[]; removed: DayKey[] }

/* ───────────────────────── Align & frames ───────────────────────── */
/** Bounding-box presets shared with timelapse-video: fit inside 3840×2160 / 1920×1080 / 1280×720, oriented like the crop. */
export type Resolution = 'source' | '2160p' | '1080p' | '720p'
export type BackdropMode = 'dimmed' | 'blurred' | 'black' | 'extended'

export interface RenderSettings {
  resolution: Resolution
  backdrop: BackdropMode
  /** Re-detect landmarks around the matched face at render time. */
  refineLandmarks: boolean
}

export interface AlignProgress {
  jobId: JobId
  done: number
  total: number
  reused: number
  failed: number
  currentPhotoId: PhotoId | null
  framesPerSecond: number
  etaMs: number | null
  /** Frames finished since the previous event (max 64). */
  recent: AlignRecent[]
}

/** Enough to render an aligned tile: aligned URL = aligned/{id}?v={version}. */
export interface AlignRecent {
  id: PhotoId
  /** Frame version (aligned route). */
  version: Version
  dayKey: DayKey
}

export interface AlignFailure { photoId: PhotoId; error: IpcError }

export interface AlignSummary {
  jobId: JobId
  total: number
  rendered: number
  reused: number
  failed: AlignFailure[]
  outputSize: Size
  durationMs: number
}

export type AlignEvent =
  | ({ type: 'started' } & JobStarted)
  | ({ type: 'progress' } & AlignProgress)
  | ({ type: 'finished' } & AlignSummary)
  | ({ type: 'failed' } & JobFailed)
  | ({ type: 'cancelled' } & JobCancelled)

/** Post-Procrustes correction in output space. Identity: { dx: 0, dy: 0, scale: 1, rotationDeg: 0 }. */
export interface FrameAdjust {
  /** Fraction of output width. */
  dx: number
  /** Fraction of output height. */
  dy: number
  scale: number
  rotationDeg: number
}

export interface FrameSummary {
  photoId: PhotoId
  dayKey: DayKey
  takenAt: LocalDateTime
  /** v1.4: as `PhotoSummary.timeKnown`. */
  timeKnown: boolean
  /** Version for the `aligned` route (geometry + look). */
  version: Version
  /** RMS anchor error after alignment, output pixels. */
  residualPx: number
  adjust: FrameAdjust
  /** What the current look does to this frame's face region (§9.6). null when look is off or stats are missing. */
  lookDelta: LookDelta | null
}

export interface LookDelta {
  /** Face-region exposure change in stops: 3·log2(L_out / L_in) on Oklab mean L. Positive = brightened. */
  exposureEv: number
  /** Face-region chroma (white-balance) shift: 100 × Oklab (a,b) mean distance moved. 0 in 'exposure' mode; ≈2 ≈ just noticeable. */
  colorShift: number
}

export type FramesStatus = 'none' | 'stale' | 'partial' | 'complete'
export type NormalizeMode = 'off' | 'exposure' | 'exposureAndColor'
export interface LookSettings { normalize: NormalizeMode; strength: number }

export interface FramesView {
  status: FramesStatus
  outputSize: Size | null
  render: RenderSettings
  look: LookSettings
  /** Reference anchors normalized to the output frame (anchor overlay). */
  referenceAnchors: Point[] | null
  /** Existing frames of the current fingerprint for active days, chronological. */
  frames: FrameSummary[]
}

/* ───────────────────────── Export: images ───────────────────────── */
export type ImageFormat = 'png' | 'jpeg'
export interface ImageExportSettings {
  format: ImageFormat
  /** 50..100, used for 'jpeg'. */
  jpegQuality: number
  /** false ⇒ never overwrite: YYYYMMDD_1.ext, _2, ... */
  overwrite: boolean
}

export interface ExportProgress {
  jobId: JobId
  done: number
  total: number
  currentFile: string | null
  etaMs: number | null
}

export interface ExportImagesSummary {
  jobId: JobId
  dir: string
  written: number
  /** Files that got a _n suffix because the name was taken. */
  renamed: number
  durationMs: number
}

export type ExportImagesEvent =
  | ({ type: 'started' } & JobStarted)
  | ({ type: 'progress' } & ExportProgress)
  | ({ type: 'finished' } & ExportImagesSummary)
  | ({ type: 'failed' } & JobFailed)
  | ({ type: 'cancelled' } & JobCancelled)

/* ───────────────────────── Export: video (mirrors timelapse-video options) ───────────────────────── */
export type Pace = { mode: 'fps'; fps: number } | { mode: 'duration'; seconds: number }
export type VideoQuality = 'low' | 'medium' | 'high' | 'max' | { bitrate: { kbps: number } }
export type Easing = 'linear' | 'easeInOut'
export interface Crossfade { frames: number; easing: Easing }
export type CaptionPosition =
  | 'topLeft' | 'topCenter' | 'topRight'
  | 'bottomLeft' | 'bottomCenter' | 'bottomRight'
export interface CaptionOptions {
  position: CaptionPosition
  /** Text em-height as a fraction of output height, 0.01..0.2. */
  size: number
  /** chrono strftime, e.g. '%b %-d, %Y'. */
  format: string
}

export interface VideoSettings {
  pace: Pace
  /** 'source' = master frame size. Never larger than the masters. */
  resolution: Resolution
  quality: VideoQuality
  crossfade: Crossfade
  /** null ⇒ no caption. */
  caption: CaptionOptions | null
  holdFirstSecs: number
  holdLastSecs: number
}

export interface VideoProgress {
  jobId: JobId
  framesDone: number
  framesTotal: number
  encodeFps: number
  etaMs: number | null
}

export interface VideoSummary {
  jobId: JobId
  path: string
  frames: number
  durationSecs: number
  bytes: number
  elapsedMs: number
}

export type ExportVideoEvent =
  | ({ type: 'started' } & JobStarted)
  | ({ type: 'progress' } & VideoProgress)
  | ({ type: 'finished' } & VideoSummary)
  | ({ type: 'failed' } & JobFailed)
  | ({ type: 'cancelled' } & JobCancelled)

/* ───────────────────────── Session ───────────────────────── */
export type ScanStatus = 'none' | 'partial' | 'complete'
export interface ScanInfo {
  status: ScanStatus
  lastSummary: ScanSummary | null
  scannedAt: LocalDateTime | null
}

export interface FramesInfo {
  status: FramesStatus
  /** Frames existing for the current fingerprint and active days. */
  count: number
  /** Active days. */
  expected: number
  outputSize: Size | null
}

export interface Recents { references: string[]; folders: string[] }

export interface SessionSnapshot {
  reference: ReferenceState | null
  folder: FolderInfo | null
  scan: ScanInfo
  counts: LibraryCounts
  render: RenderSettings
  look: LookSettings
  frames: FramesInfo
  imageExport: ImageExportSettings
  video: VideoSettings
  activeJob: ActiveJob | null
  recents: Recents
}

/* ───────────────────────── Commands ───────────────────────── */
export type NoArgs = Record<string, never>

export interface CommandMap {
  get_app_info: { args: NoArgs; result: AppInfo }
  get_session: { args: NoArgs; result: SessionSnapshot }
  reset_session: { args: NoArgs; result: SessionSnapshot }
  pick_reference_photo: { args: NoArgs; result: ReferenceState | null }
  set_reference_photo: { args: { path: string }; result: ReferenceState }
  set_reference_rotation: { args: { rotationDeg: number }; result: ReferenceState }
  set_reference_crop: { args: { crop: Rect; aspect: AspectPreset }; result: ReferenceState }
  pick_source_folder: { args: NoArgs; result: FolderInfo | null }
  set_source_folder: { args: { path: string }; result: FolderInfo }
  clear_scan_cache: { args: { scope: CacheScope }; result: ClearCacheResult }
  start_scan: { args: { onEvent: Channel<ScanEvent> }; result: JobId }
  cancel_job: { args: { jobId: JobId }; result: null }
  get_photos: { args: { query: PhotoQuery }; result: PhotoSummary[] }
  get_photo: { args: { photoId: PhotoId }; result: PhotoDetail }
  set_review_decision: { args: { photoIds: PhotoId[]; decision: ReviewDecision }; result: LibraryCounts }
  get_days: { args: NoArgs; result: DayGroup[] }
  select_day_photo: { args: { dayKey: DayKey; photoId: PhotoId }; result: DayGroup }
  move_photo_to_day: { args: { photoId: PhotoId; dayKey: DayKey }; result: DaysPatch }
  add_photo_to_day: { args: { dayKey: DayKey; path: string | null }; result: DaysPatch | null }
  set_day_excluded: { args: { dayKey: DayKey; excluded: boolean }; result: DayGroup }
  start_align: { args: { render: RenderSettings; onEvent: Channel<AlignEvent> }; result: JobId }
  get_frames: { args: NoArgs; result: FramesView }
  set_frame_adjustment: { args: { photoId: PhotoId; adjust: FrameAdjust }; result: FrameSummary }
  set_look: { args: { look: LookSettings }; result: FramesView }
  pick_export_folder: { args: NoArgs; result: string | null }
  start_export_images: {
    args: { dir: string; settings: ImageExportSettings; onEvent: Channel<ExportImagesEvent> }
    result: JobId
  }
  pick_video_path: { args: { suggestedName: string }; result: string | null }
  start_export_video: {
    args: { path: string; settings: VideoSettings; onEvent: Channel<ExportVideoEvent> }
    result: JobId
  }
  reveal_path: { args: { path: string }; result: null }
  /** v1.5: validates and saves `session.video` without exporting; allowed while a job runs. */
  set_video_settings: { args: { settings: VideoSettings }; result: VideoSettings }
  /** v1.7: opens a finished exported video (an `.mp4` in the session's outputs) in its default app. */
  open_path: { args: { path: string }; result: null }
}

export type CommandName = keyof CommandMap

/* ───────────────────────── Image protocol ───────────────────────── */
export const THUMB_WIDTHS = [160, 320, 640, 1280, 2048] as const
export const ALIGNED_WIDTHS = [160, 320, 640, 1280] as const
export const REFERENCE_WIDTHS = [320, 640, 1280, 2048] as const
export const REFERENCE_FRAME_WIDTHS = [160, 320, 640, 1280] as const
/** v1.7: widths of the preview route. */
export const PREVIEW_WIDTHS = [640, 1280] as const

export type ImageRoute =
  | { kind: 'thumb'; photoId: PhotoId; version: Version; width: number }
  /** width null ⇒ full master size. */
  | { kind: 'aligned'; photoId: PhotoId; version: Version; width: number | null }
  | { kind: 'reference'; version: Version; width: number }
  | { kind: 'referenceFrame'; version: Version; width: number }
  /** v1.7: a photo's aligned frame rendered on demand; version = PhotoDetail.previewVersion. */
  | { kind: 'preview'; photoId: PhotoId; version: Version; width: number }

/** Builds a protocol URL; `base` is AppInfo.imageBaseUrl. Width is sent as given; the server rounds up to a bucket. */
export function imageUrl(base: string, route: ImageRoute): string {
  switch (route.kind) {
    case 'thumb':
      return `${base}thumb/${route.photoId}?w=${route.width}&v=${route.version}`
    case 'aligned':
      return route.width === null
        ? `${base}aligned/${route.photoId}?v=${route.version}`
        : `${base}aligned/${route.photoId}?w=${route.width}&v=${route.version}`
    case 'reference':
      return `${base}reference?w=${route.width}&v=${route.version}`
    case 'referenceFrame':
      return `${base}reference/frame?w=${route.width}&v=${route.version}`
    case 'preview':
      return `${base}preview/${route.photoId}?w=${route.width}&v=${route.version}`
  }
}

/** Score cut-offs (legacy semantics, used for colors/badges). */
export const SCORE_CONFIRMED = 0.6
export const SCORE_UNCERTAIN = 0.4
