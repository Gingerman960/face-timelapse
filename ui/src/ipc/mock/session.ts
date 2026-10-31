// SessionSnapshot and the other read models derived from MockState.
import type { ActiveJob, FolderInfo, FramesInfo, LibraryCounts, SessionSnapshot } from '../contract'
import { DEMO_FOLDER_NAME, LIBRARY_SIZE, UNSUPPORTED_COUNT } from './fixtures'
import { daysOf } from './days'
import { framesOf } from './frames'
import { libraryOf } from './library'
import { baseName } from './mockFs'
import { referenceStateOf } from './reference'
import { EMPTY_SCAN, type FolderState, type MockState, currentFolder } from './state'

export const EMPTY_COUNTS: LibraryCounts = {
  total: 0,
  confirmed: 0,
  uncertain: 0,
  rejected: 0,
  noFace: 0,
  failed: 0,
  reviewPending: 0,
  included: 0,
  days: 0,
  activeDays: 0,
}

export function countsOf(folder: FolderState | null): LibraryCounts {
  if (!folder) return EMPTY_COUNTS
  const { photos } = libraryOf(folder)
  const days = daysOf(folder)
  const byStatus = { confirmed: 0, uncertain: 0, rejected: 0, noFace: 0, failed: 0 }
  let reviewPending = 0
  let included = 0
  for (const p of photos) {
    byStatus[p.status] += 1
    if (p.status === 'uncertain' && p.review === 'pending') reviewPending += 1
    if (p.included) included += 1
  }
  return {
    total: photos.length,
    ...byStatus,
    reviewPending,
    included,
    days: days.length,
    activeDays: days.filter((d) => !d.excluded).length,
  }
}

export function folderInfoOf(folder: FolderState): FolderInfo {
  const demo = folder.library === 'demo'
  return {
    path: folder.path,
    name: demo ? DEMO_FOLDER_NAME : baseName(folder.path),
    imageCount: demo ? LIBRARY_SIZE : 0,
    analyzedCount: folder.cachedCount,
    unsupportedCount: demo ? UNSUPPORTED_COUNT : 0,
  }
}

export function framesInfoOf(state: MockState): FramesInfo {
  const { status, count, expected, outputSize } = framesOf(state)
  return { status, count, expected, outputSize }
}

export function snapshotOf(state: MockState, activeJob: ActiveJob | null): SessionSnapshot {
  const folder = currentFolder(state)
  return {
    reference: state.reference ? referenceStateOf(state.reference) : null,
    folder: folder ? folderInfoOf(folder) : null,
    scan: folder?.scan ?? EMPTY_SCAN,
    counts: countsOf(folder),
    render: state.render,
    look: state.look,
    frames: framesInfoOf(state),
    imageExport: state.imageExport,
    video: state.video,
    activeJob,
    recents: state.recents,
  }
}
