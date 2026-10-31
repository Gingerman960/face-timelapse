import { call, toIpcError } from '../ipc/client'
import { inContext, isCancelled, type PathContext } from '../ipc/errors'
import type {
  AspectPreset,
  CacheScope,
  DayGroup,
  DayKey,
  DaysPatch,
  FolderInfo,
  FrameAdjust,
  FrameSummary,
  FramesView,
  LibraryCounts,
  LookSettings,
  PhotoId,
  Rect,
  ReferenceState,
  ReviewDecision,
  SessionSnapshot,
} from '../ipc/contract'
import { dayPoolChanged, libraryReplaced, queryClient, queryKeys } from './queries'
import { withModelsNote } from './models'
import { usePlayer } from './player'
import { resetVideoDraft } from './videoDraft'
import { useView } from './view'

function patchSession(patch: Partial<SessionSnapshot>): void {
  queryClient.setQueryData<SessionSnapshot>(queryKeys.session, (prev) => (prev ? { ...prev, ...patch } : prev))
}

async function sessionChanged(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.session })
}

/**
 * Shows an error as a toast and returns it (for callers that also render it
 * inline). Commands whose `cancelled` means "superseded" handle it themselves
 * (UI review 2, M4). Identical toasts coalesce in the view store, so a burst
 * of `busy` shows once.
 */
export function reportError(error: unknown): ReturnType<typeof toIpcError> {
  // Missing face models read as the one models message, and turn the notice on (QA).
  const e = withModelsNote(toIpcError(error))
  useView.getState().pushToast({ message: e.message, tone: 'stop' })
  return e
}

/**
 * Runs a folder pick or set that a newer choice (or a reset) can supersede
 * (v1.3 `cancelled`): it then resolves null with nothing to show, and the
 * session is re-read so the newest choice is on screen.
 */
async function unlessSuperseded<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run()
  } catch (error) {
    if (!isCancelled(toIpcError(error))) throw error
    await sessionChanged()
    return null
  }
}

/** Runs a command that takes a user-chosen path; a refusal gets the message for this place. */
async function withPath<T>(context: PathContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw inContext(toIpcError(error), context)
  }
}

function referenceChanged(reference: ReferenceState): ReferenceState {
  patchSession({ reference })
  dayPoolChanged()
  // Matching re-runs against the new reference: every matched face may change.
  void queryClient.invalidateQueries({ queryKey: queryKeys.photoAll })
  return reference
}

/** Opens the native photo picker; null when the user cancels. */
export async function pickReferencePhoto(): Promise<ReferenceState | null> {
  const reference = await withPath('reference', () => call('pick_reference_photo'))
  return reference ? referenceChanged(reference) : null
}

/** Uses a dropped or recent photo as the reference. */
export async function setReferencePhoto(path: string): Promise<ReferenceState> {
  return referenceChanged(await withPath('reference', () => call('set_reference_photo', { path })))
}

/** Rotates the reference; the backend carries the crop through the rotation (`reference::rotate_crop`). */
export async function setReferenceRotation(rotationDeg: number): Promise<ReferenceState> {
  return referenceChanged(await call('set_reference_rotation', { rotationDeg }))
}

/** Commits a crop + aspect; the backend re-matches the library in memory. */
export async function setReferenceCrop(crop: Rect, aspect: AspectPreset): Promise<ReferenceState> {
  return referenceChanged(await call('set_reference_crop', { crop, aspect }))
}

function folderChanged(folder: FolderInfo): FolderInfo {
  patchSession({ folder })
  libraryReplaced()
  useView.getState().resetLibraryView()
  return folder
}

/** Opens the native folder picker; null when the user cancels or a newer choice superseded it. */
export async function pickSourceFolder(): Promise<FolderInfo | null> {
  const folder = await unlessSuperseded(() => withPath('folder', () => call('pick_source_folder')))
  return folder ? folderChanged(folder) : null
}

/**
 * Uses a dropped or recent folder as the library. Resolves null when a newer
 * folder choice (or a reset) replaced this one (v1.3 `cancelled`): nothing to
 * show, and the session is re-read so the newest choice is on screen.
 */
export async function setSourceFolder(path: string): Promise<FolderInfo | null> {
  const folder = await unlessSuperseded(() => withPath('folder', () => call('set_source_folder', { path })))
  return folder ? folderChanged(folder) : null
}

/** Forgets cached analysis so the next scan reads every photo again. */
export async function clearScanCache(scope: CacheScope): Promise<void> {
  await call('clear_scan_cache', { scope })
  libraryReplaced()
  useView.getState().resetLibraryView()
  await sessionChanged()
}

/**
 * Records review decisions; returns the new counts. `refresh: false` leaves
 * the photo list alone (Review batches decisions and refreshes once at the end).
 */
export async function setReviewDecision(photoIds: PhotoId[], decision: ReviewDecision, { refresh = true } = {}): Promise<LibraryCounts> {
  const counts = await call('set_review_decision', { photoIds, decision })
  patchSession({ counts })
  if (refresh) dayPoolChanged()
  return counts
}

function upsertDay(day: DayGroup): void {
  queryClient.setQueryData<DayGroup[]>(queryKeys.days, (prev) =>
    prev ? prev.map((d) => (d.dayKey === day.dayKey ? day : d)) : prev,
  )
}

/** Applies a DaysPatch (upserts + removals) to the cached day list, keeping dayKey order. */
export function applyDaysPatch(prev: DayGroup[], patch: DaysPatch): DayGroup[] {
  const removed = new Set(patch.removed)
  const map = new Map(prev.filter((d) => !removed.has(d.dayKey)).map((d) => [d.dayKey, d]))
  for (const d of patch.upserted) map.set(d.dayKey, d)
  return [...map.values()].sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0))
}

function daysPatched(patch: DaysPatch): void {
  queryClient.setQueryData<DayGroup[]>(queryKeys.days, (prev) => (prev ? applyDaysPatch(prev, patch) : prev))
  dayPoolChanged()
}

/** Chooses which photo represents a day. */
/** Picks asked for and not answered yet, per day: repeated ↑/↓ build on these, not on the cache (UI review 2, L3). */
const requestedPicks = new Map<DayKey, PhotoId>()

/** The photo last asked to be `dayKey`'s pick while that request is in flight, else undefined. */
export function requestedPick(dayKey: DayKey): PhotoId | undefined {
  return requestedPicks.get(dayKey)
}

export async function selectDayPhoto(dayKey: DayKey, photoId: PhotoId): Promise<DayGroup> {
  requestedPicks.set(dayKey, photoId)
  try {
    const day = await call('select_day_photo', { dayKey, photoId })
    upsertDay(day)
    dayPoolChanged()
    return day
  } finally {
    if (requestedPicks.get(dayKey) === photoId) requestedPicks.delete(dayKey)
  }
}

/** Moves a photo to another day (dnd-kit drop or the M key). */
export async function movePhotoToDay(photoId: PhotoId, dayKey: DayKey): Promise<DaysPatch> {
  const patch = await call('move_photo_to_day', { photoId, dayKey })
  daysPatched(patch)
  return patch
}

/**
 * Adds a photo to a day (null path opens the native picker). `cancelled` here
 * means the folder changed while the photo was read (v1.3): its message ("…
 * Add it again.") shows as an info toast, and nothing is added.
 */
export async function addPhotoToDay(dayKey: DayKey, path: string | null): Promise<DaysPatch | null> {
  try {
    const patch = await withPath('addPhoto', () => call('add_photo_to_day', { dayKey, path }))
    if (patch) daysPatched(patch)
    return patch
  } catch (error) {
    const e = toIpcError(error)
    if (!isCancelled(e)) throw e
    useView.getState().pushToast({ message: e.message, tone: 'info' })
    return null
  }
}

/** Leaves a day out of (or back into) the timelapse. */
export async function setDayExcluded(dayKey: DayKey, excluded: boolean): Promise<DayGroup> {
  const day = await call('set_day_excluded', { dayKey, excluded })
  upsertDay(day)
  dayPoolChanged()
  return day
}

/**
 * Leaves several days out or puts them back (a run of days, critique round 6,
 * P1-4): one `set_day_excluded` after another, so the backend's mutation gate
 * sees one change at a time, and one refresh of what depends on the day pool
 * at the end. Stops at the first refusal and rethrows it; the days done
 * before it stay done (the cache shows them).
 */
export async function setDaysExcluded(changes: readonly { dayKey: DayKey; excluded: boolean }[]): Promise<void> {
  try {
    for (const { dayKey, excluded } of changes) upsertDay(await call('set_day_excluded', { dayKey, excluded }))
  } finally {
    if (changes.length > 0) dayPoolChanged()
  }
}

const IDENTITY_ADJUST: FrameAdjust = { dx: 0, dy: 0, scale: 1, rotationDeg: 0 }

/** A nudge on its way: the merged adjust last sent, and the frame as last confirmed by the backend. */
interface PendingAdjust {
  seq: number
  adjust: FrameAdjust
  confirmed: FrameSummary | undefined
}

/** Nudges in flight, per photo; `adjustSeq` orders every request so an older answer never wins. */
const pendingAdjusts = new Map<PhotoId, PendingAdjust>()
let adjustSeq = 0

function cachedFrame(photoId: PhotoId): FrameSummary | undefined {
  return queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames.find((f) => f.photoId === photoId)
}

function replaceFrame(photoId: PhotoId, next: (frame: FrameSummary) => FrameSummary): void {
  queryClient.setQueryData<FramesView>(queryKeys.frames, (prev) =>
    prev ? { ...prev, frames: prev.frames.map((f) => (f.photoId === photoId ? next(f) : f)) } : prev,
  )
}

/**
 * Re-renders one frame with a manual nudge (UI review 2, H3). `patch` merges
 * into the newest adjust asked for, even one still in flight, and shows at
 * once; only the answer to the newest request lands on screen. An older
 * request that succeeds meanwhile becomes the confirmed state (the backend
 * applied it), so a failure of the newest puts that back, never something
 * older (UI review 3, M1); the frames are then re-read, since a look change
 * may have landed in between.
 */
export async function setFrameAdjustment(photoId: PhotoId, patch: Partial<FrameAdjust>): Promise<void> {
  const prev = pendingAdjusts.get(photoId)
  const cached = cachedFrame(photoId)
  const adjust: FrameAdjust = { ...(prev?.adjust ?? cached?.adjust ?? IDENTITY_ADJUST), ...patch }
  adjustSeq += 1
  const seq = adjustSeq
  pendingAdjusts.set(photoId, { seq, adjust, confirmed: prev ? prev.confirmed : cached })
  replaceFrame(photoId, (f) => ({ ...f, adjust }))
  try {
    const frame = await call('set_frame_adjustment', { photoId, adjust })
    // The photo's preview version follows its nudge (contract v1.7): Review reads it again.
    void queryClient.invalidateQueries({ queryKey: queryKeys.photo(photoId) })
    const latest = pendingAdjusts.get(photoId)
    if (latest && latest.seq !== seq) {
      // A newer nudge is in flight: this one is what the backend has now.
      pendingAdjusts.set(photoId, { ...latest, confirmed: frame })
      return
    }
    pendingAdjusts.delete(photoId)
    replaceFrame(photoId, () => frame)
  } catch (error) {
    const latest = pendingAdjusts.get(photoId)
    if (latest?.seq === seq) {
      pendingAdjusts.delete(photoId)
      if (latest.confirmed) replaceFrame(photoId, () => latest.confirmed as FrameSummary)
      void queryClient.invalidateQueries({ queryKey: queryKeys.frames })
    }
    throw error
  }
}

let lookSeq = 0
/** The look asked for and not answered yet: a toggle pressed again builds on it (UI review 2, L3). */
let pendingLook: LookSettings | null = null

/** The look last asked for while it is in flight, else null (the cache is current). */
export function requestedLook(): LookSettings | null {
  return pendingLook
}

/**
 * Changes the look (exposure / white-balance evening); frames get new
 * versions. Responses can arrive out of order, so only the newest request
 * updates the caches, and the session takes the look the backend applied.
 * When the newest fails after an older one landed, the caches are re-read,
 * so they never disagree with the backend.
 */
export async function setLook(look: LookSettings): Promise<FramesView> {
  lookSeq += 1
  const seq = lookSeq
  pendingLook = look
  try {
    const view = await call('set_look', { look })
    if (seq === lookSeq) {
      queryClient.setQueryData(queryKeys.frames, view)
      patchSession({ look: view.look })
    }
    return view
  } catch (error) {
    if (seq === lookSeq) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.frames })
      void queryClient.invalidateQueries({ queryKey: queryKeys.session })
    }
    throw error
  } finally {
    if (seq === lookSeq) pendingLook = null
  }
}

/** Reveals an output this app wrote in Finder / Explorer. */
export async function revealPath(path: string): Promise<void> {
  try {
    await withPath('reveal', () => call('reveal_path', { path }))
  } catch (error) {
    reportError(error)
  }
}

/**
 * Opens a video this session exported in the default player (contract v1.7
 * `open_path`); false, with the reason shown, when it can't be opened.
 */
export async function openPath(path: string): Promise<boolean> {
  try {
    await withPath('open', () => call('open_path', { path }))
    return true
  } catch (error) {
    reportError(error)
    return false
  }
}

/** Starts a fresh session (caches, recents and exported files kept). */
export async function resetSession(): Promise<void> {
  // Before the reset: a save of the old session's video settings that fired while
  // it ran could otherwise land in the new one (UI review 3, L2).
  resetVideoDraft()
  usePlayer.getState().resetPlayback()
  const session = await call('reset_session')
  libraryReplaced()
  useView.getState().resetLibraryView()
  queryClient.setQueryData(queryKeys.session, session)
}
