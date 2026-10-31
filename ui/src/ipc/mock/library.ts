// The library as the UI sees it: fixture photos that this session has matched
// (a chronological prefix while a scan runs) plus manually added photos, with
// the folder's review decisions and day moves applied.
import type { DayKey, PhotoId, PhotoSummary } from '../contract'
import { type FixturePhoto, demoLibrary, extraPhotos, naturalCompare } from './fixtures'
import type { FolderDecisions, FolderState } from './state'

export interface LibraryView {
  /** relPath natural order (get_photos order). */
  readonly photos: readonly PhotoSummary[]
  readonly byId: ReadonlyMap<PhotoId, PhotoSummary>
  /** Fixture data (faces, path) of the photos in the library. */
  readonly fixtures: ReadonlyMap<PhotoId, FixturePhoto>
}

const EMPTY_LIBRARY: LibraryView = { photos: [], byId: new Map(), fixtures: new Map() }
const cache = new WeakMap<FolderState, LibraryView>()

export function isIncluded(review: PhotoSummary['review'], status: PhotoSummary['status']): boolean {
  return review === 'confirmed' || (review === 'pending' && status === 'confirmed')
}

export function summaryOf(photo: FixturePhoto, decisions: FolderDecisions, manualDay: DayKey | null): PhotoSummary {
  const review = manualDay !== null ? 'confirmed' : (decisions.reviews[photo.id] ?? 'pending')
  const movedTo = manualDay ?? decisions.dayMoves[photo.id]
  const matched = photo.matchedFace === null ? undefined : photo.faces[photo.matchedFace]
  return {
    id: photo.id,
    fileName: photo.fileName,
    relPath: photo.relPath,
    takenAt: photo.takenAt,
    dateSource: movedTo === undefined ? photo.dateSource : 'manual',
    // Contract v1.4: as the fixture says; a hand-added photo has no time of day.
    timeKnown: manualDay === null && photo.timeKnown,
    dayKey: movedTo ?? photo.dayKey,
    score: photo.score,
    status: photo.status,
    review,
    included: isIncluded(review, photo.status),
    size: photo.size,
    faceBox: matched ? matched.bounds : null,
    version: photo.version,
  }
}

function buildLibrary(folder: FolderState): LibraryView {
  const { decisions } = folder
  const extrasById = new Map(extraPhotos().map((p) => [p.id, p]))
  const manual = decisions.manualPhotos
    .map((m) => ({ photo: extrasById.get(m.photoId), dayKey: m.dayKey }))
    .filter((m): m is { photo: FixturePhoto; dayKey: DayKey } => m.photo !== undefined)
    .sort((a, b) => naturalCompare(a.photo.relPath, b.photo.relPath))
  const own = folder.library === 'demo' ? demoLibrary().byRelPath.filter((p) => p.index < folder.libraryCount) : []
  const fixtures = [...manual.map((m) => m.photo), ...own]
  const photos = [
    ...manual.map((m) => summaryOf(m.photo, decisions, m.dayKey)),
    ...own.map((p) => summaryOf(p, decisions, null)),
  ]
  return {
    photos,
    byId: new Map(photos.map((p) => [p.id, p])),
    fixtures: new Map(fixtures.map((p) => [p.id, p])),
  }
}

/** Memoized per (immutable) folder state. */
export function libraryOf(folder: FolderState | null): LibraryView {
  if (!folder) return EMPTY_LIBRARY
  const hit = cache.get(folder)
  if (hit) return hit
  const view = buildLibrary(folder)
  cache.set(folder, view)
  return view
}
