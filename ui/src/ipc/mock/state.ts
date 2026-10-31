// Immutable session state of the fake backend. Every mutation returns a new
// MockState; derived views (library, days, counts, frames) are memoized per
// state object in library.ts / days.ts / frames.ts.
import type {
  AspectPreset,
  DayKey,
  FrameAdjust,
  ImageExportSettings,
  LookSettings,
  PhotoId,
  Recents,
  Rect,
  RenderSettings,
  ReviewDecision,
  ScanInfo,
  Version,
  VideoSettings,
} from '../contract'
import { DEMO_FOLDER } from './fixtures'
import type { ReferenceVariant } from './versions'

export interface ReferenceModel {
  readonly path: string
  readonly variant: ReferenceVariant
  readonly rotationDeg: number
  /** Pixels of the rotated canvas. */
  readonly crop: Rect
  readonly aspect: AspectPreset
}

export interface ManualPhoto {
  readonly photoId: PhotoId
  readonly dayKey: DayKey
}

/** User decisions, persisted per source folder (ARCHITECTURE §4.3). */
export interface FolderDecisions {
  readonly reviews: Readonly<Record<PhotoId, ReviewDecision>>
  readonly dayMoves: Readonly<Record<PhotoId, DayKey>>
  readonly manualPhotos: readonly ManualPhoto[]
  readonly daySelections: Readonly<Record<DayKey, PhotoId>>
  readonly excludedDays: readonly DayKey[]
  readonly adjusts: Readonly<Record<PhotoId, FrameAdjust>>
}

export type LibraryKind = 'demo' | 'empty'

export interface FolderState {
  readonly path: string
  readonly library: LibraryKind
  /** Files with a valid cached analysis (chronological prefix of the library). */
  readonly cachedCount: number
  /** Photos matched into this session's library (chronological prefix). */
  readonly libraryCount: number
  readonly scan: ScanInfo
  readonly decisions: FolderDecisions
}

export interface FrameRecord {
  readonly photoVersion: Version
  readonly adjust: FrameAdjust
  readonly residualPx: number
}

export interface MockState {
  readonly reference: ReferenceModel | null
  readonly folderPath: string | null
  readonly folders: Readonly<Record<string, FolderState>>
  readonly render: RenderSettings
  readonly look: LookSettings
  readonly imageExport: ImageExportSettings
  readonly video: VideoSettings
  /** Aligned masters on "disk": fingerprint → photo → record. */
  readonly frames: Readonly<Record<string, Readonly<Record<PhotoId, FrameRecord>>>>
  readonly recents: Recents
  /** Directories and files written by exports in this session (reveal_path). */
  readonly outputs: readonly string[]
  /** Targets of cancelled/failed video exports (the partial file was deleted). */
  readonly discarded: readonly string[]
  /** Export dir → file names written there (for the `_1` suffix rule). */
  readonly exported: Readonly<Record<string, readonly string[]>>
  /** Mock wall clock, ms of the naive local time read as UTC. */
  readonly clock: number
}

/* ─────────────── Defaults (ARCHITECTURE §7.5 "Defaults (fresh session)") ─────────────── */

export const IDENTITY_ADJUST: FrameAdjust = { dx: 0, dy: 0, scale: 1, rotationDeg: 0 }
export const DEFAULT_RENDER: RenderSettings = { resolution: '1080p', backdrop: 'extended', refineLandmarks: true }
export const DEFAULT_LOOK: LookSettings = { normalize: 'off', strength: 0.7 }
export const DEFAULT_IMAGE_EXPORT: ImageExportSettings = { format: 'png', jpegQuality: 95, overwrite: false }
export const DEFAULT_VIDEO: VideoSettings = {
  pace: { mode: 'fps', fps: 10 },
  resolution: 'source',
  quality: 'high',
  crossfade: { frames: 0, easing: 'easeInOut' },
  caption: null,
  holdFirstSecs: 0,
  holdLastSecs: 1,
}
export const EMPTY_SCAN: ScanInfo = { status: 'none', lastSummary: null, scannedAt: null }
export const EMPTY_DECISIONS: FolderDecisions = {
  reviews: {},
  dayMoves: {},
  manualPhotos: [],
  daySelections: {},
  excludedDays: [],
  adjusts: {},
}
export const EMPTY_RECENTS: Recents = { references: [], folders: [] }
const MAX_RECENTS = 8

/** Mock clock start: 24 Oct 2026, 09:30 local. */
export const CLOCK_START = Date.UTC(2026, 9, 24, 9, 30, 0)

export function freshState(recents: Recents = EMPTY_RECENTS, frames: MockState['frames'] = {}): MockState {
  return {
    reference: null,
    folderPath: null,
    folders: {},
    render: DEFAULT_RENDER,
    look: DEFAULT_LOOK,
    imageExport: DEFAULT_IMAGE_EXPORT,
    video: DEFAULT_VIDEO,
    frames,
    recents,
    outputs: [],
    discarded: [],
    exported: {},
    clock: CLOCK_START,
  }
}

export function newFolderState(path: string): FolderState {
  return {
    path,
    library: path === DEMO_FOLDER ? 'demo' : 'empty',
    cachedCount: 0,
    libraryCount: 0,
    scan: EMPTY_SCAN,
    decisions: EMPTY_DECISIONS,
  }
}

/* ─────────────── Small immutable helpers ─────────────── */

export function currentFolder(state: MockState): FolderState | null {
  return state.folderPath === null ? null : (state.folders[state.folderPath] ?? null)
}

export function withFolder(state: MockState, folder: FolderState): MockState {
  return { ...state, folders: { ...state.folders, [folder.path]: folder } }
}

export function updateFolder(state: MockState, update: (folder: FolderState) => FolderState): MockState {
  const folder = currentFolder(state)
  return folder ? withFolder(state, update(folder)) : state
}

export function updateDecisions(state: MockState, update: (d: FolderDecisions) => FolderDecisions): MockState {
  return updateFolder(state, (folder) => ({ ...folder, decisions: update(folder.decisions) }))
}

/** Most-recent-first list without duplicates, capped. */
export function pushRecent(list: readonly string[], item: string): string[] {
  return [item, ...list.filter((x) => x !== item)].slice(0, MAX_RECENTS)
}

/** Record without `key`. */
export function omitKey<V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}

/** 'YYYY-MM-DDTHH:MM:SS' of the mock clock. */
export function clockText(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19)
}

export function sameAdjust(a: FrameAdjust, b: FrameAdjust): boolean {
  return a.dx === b.dx && a.dy === b.dy && a.scale === b.scale && a.rotationDeg === b.rotationDeg
}
