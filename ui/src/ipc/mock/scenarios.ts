// Initial sessions for `?mock=<scenario>`.
//   fresh    first run: nothing chosen yet
//   ready    reference (restored 3:4 crop) + folder; not scanned (412 files cached from earlier)
//   scanned  scan complete, 41 uncertain photos waiting for review
//   reviewed 29 uncertain kept, 12 left out; days ready; no frames
//   aligned  everything done, frames complete for all active days, look off (restored-session default)
import type { FrameAdjust, PhotoId, ReviewDecision, ScanSummary } from '../contract'
import {
  DEMO_FOLDER,
  LIBRARY_SIZE,
  REFERENCE_PATH,
  RESTORED_ASPECT,
  RESTORED_CROP,
  STATUS_TOTALS,
  demoLibrary,
} from './fixtures'
import { fingerprintOf, framesOf, residualFor } from './frames'
import type { MockScenario } from './options'
import { hash32, round, unitHash } from './random'
import { RESCAN_FROM_CACHE } from './scanJob'
import {
  type FolderState,
  type FrameRecord,
  IDENTITY_ADJUST,
  type MockState,
  freshState,
  newFolderState,
  withFolder,
} from './state'

export const RESTORED_SCANNED_AT = '2026-10-23T21:14:05'
/** Frames the user nudged in the restored session. */
const ADJUSTED_FRAMES = 12

export const RESTORED_SCAN_SUMMARY: ScanSummary = {
  jobId: 'scan-0',
  total: LIBRARY_SIZE,
  fromCache: 0,
  analyzed: LIBRARY_SIZE,
  ...STATUS_TOTALS,
  durationMs: 92_128,
}

function readyState(): MockState {
  const base = freshState({ references: [REFERENCE_PATH], folders: [DEMO_FOLDER] })
  const folder: FolderState = { ...newFolderState(DEMO_FOLDER), cachedCount: RESCAN_FROM_CACHE }
  return withFolder(
    {
      ...base,
      reference: { path: REFERENCE_PATH, variant: 'portrait', rotationDeg: 0, crop: RESTORED_CROP, aspect: RESTORED_ASPECT },
      folderPath: DEMO_FOLDER,
    },
    folder,
  )
}

function scannedState(): MockState {
  const state = readyState()
  const folder = state.folders[DEMO_FOLDER] ?? newFolderState(DEMO_FOLDER)
  return withFolder(state, {
    ...folder,
    cachedCount: LIBRARY_SIZE,
    libraryCount: LIBRARY_SIZE,
    scan: { status: 'complete', lastSummary: RESTORED_SCAN_SUMMARY, scannedAt: RESTORED_SCANNED_AT },
  })
}

function reviewedState(): MockState {
  const state = scannedState()
  const folder = state.folders[DEMO_FOLDER] ?? newFolderState(DEMO_FOLDER)
  const reviews: Record<PhotoId, ReviewDecision> = Object.fromEntries(
    demoLibrary().photos.flatMap((p) => (p.reviewOutcome ? [[p.id, p.reviewOutcome]] : [])),
  )
  return withFolder(state, { ...folder, decisions: { ...folder.decisions, reviews } })
}

/** A small deterministic nudge, as if the user fixed an outlier. */
function nudgeFor(photoId: PhotoId): FrameAdjust {
  const u = (salt: string) => unitHash(`${salt}:${photoId}`) - 0.5
  return {
    dx: round(u('dx') * 0.04, 3),
    dy: round(u('dy') * 0.04, 3),
    scale: round(1 + u('scale') * 0.08, 3),
    rotationDeg: round(u('rot') * 5, 1),
  }
}

function alignedState(): MockState {
  const reviewed = reviewedState()
  const base: MockState = { ...reviewed, video: { ...reviewed.video, pace: { mode: 'fps', fps: 30 } } }
  const active = framesOf(base).active
  const adjusted = active
    .map((a) => a.photoId)
    .sort((a, b) => hash32(`adjust:${a}`) - hash32(`adjust:${b}`))
    .slice(0, ADJUSTED_FRAMES)
  const adjusts: Record<PhotoId, FrameAdjust> = Object.fromEntries(adjusted.map((id) => [id, nudgeFor(id)]))
  const folder = base.folders[DEMO_FOLDER] ?? newFolderState(DEMO_FOLDER)
  const withAdjusts = withFolder(base, { ...folder, decisions: { ...folder.decisions, adjusts } })
  const fingerprint = fingerprintOf(withAdjusts)
  if (fingerprint === null) return withAdjusts
  const records: Record<PhotoId, FrameRecord> = Object.fromEntries(
    active.map((a) => [
      a.photoId,
      { photoVersion: a.fixture.version, adjust: adjusts[a.photoId] ?? IDENTITY_ADJUST, residualPx: residualFor(a.photoId) },
    ]),
  )
  return { ...withAdjusts, frames: { [fingerprint]: records } }
}

export function scenarioState(scenario: MockScenario): MockState {
  switch (scenario) {
    case 'fresh':
      return freshState()
    case 'ready':
      return readyState()
    case 'scanned':
      return scannedState()
    case 'reviewed':
      return reviewedState()
    case 'aligned':
      return alignedState()
  }
}
