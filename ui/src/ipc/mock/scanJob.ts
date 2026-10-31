// Scan job: cache hits first (one progress event), then misses in
// chronological order so the decade ribbon exposes left to right.
import type { IpcError, JobId, ScanEvent, ScanRecent, ScanSummary } from '../contract'
import { type FixturePhoto, demoLibrary } from './fixtures'
import { type JobScript, chunkBoundaries } from './jobs'
import { round, unitHash } from './random'
import { type FolderState, type MockState, clockText, currentFolder, updateFolder } from './state'

/** A rescan of a complete library re-reads all but the files the cache still vouches for. */
export const RESCAN_FROM_CACHE = 412
/** Display throughput (DESIGN: "38 photos/s · 12 workers"). */
const PHOTOS_PER_SECOND = 38
/** Narrative throughput for summaries (a full scan reads in 1 min 32 s). */
const SUMMARY_PHOTOS_PER_SECOND = 39
const MAX_RECENT = 64

export interface JobEnv {
  readonly jobId: JobId
  get(): MockState
  set(next: MockState): void
  readonly steps: number
}

type Tally = Pick<ScanSummary, 'confirmed' | 'uncertain' | 'rejected' | 'noFace' | 'failed'>

function tally(photos: readonly FixturePhoto[]): Tally {
  const t = { confirmed: 0, uncertain: 0, rejected: 0, noFace: 0, failed: 0 }
  for (const p of photos) t[p.status] += 1
  return t
}

function fromCacheFor(folder: FolderState, total: number): number {
  return folder.scan.status === 'complete' ? Math.min(RESCAN_FROM_CACHE, total) : Math.min(folder.cachedCount, total)
}

export function scanScript(env: JobEnv): JobScript<ScanEvent> {
  const start = currentFolder(env.get())
  const photos = start?.library === 'demo' ? demoLibrary().photos : []
  const previousStatus = start?.scan.status ?? 'none'
  const total = photos.length
  const fromCache = start ? fromCacheFor(start, total) : 0
  const misses = total - fromCache
  const missSteps = fromCache > 0 ? Math.max(1, env.steps - 1) : env.steps
  const boundaries = [
    ...(fromCache > 0 ? [fromCache] : []),
    ...chunkBoundaries(misses, missSteps).map((b) => fromCache + b),
  ]
  let done = 0

  const recentOf = (slice: readonly FixturePhoto[]): ScanRecent[] => {
    const moves = currentFolder(env.get())?.decisions.dayMoves ?? {}
    return slice
      .filter((p) => p.status === 'confirmed' || p.status === 'uncertain')
      .slice(-MAX_RECENT)
      .map((p) => ({
        id: p.id,
        version: p.version,
        dayKey: moves[p.id] ?? p.dayKey,
        status: p.status === 'confirmed' ? 'confirmed' : 'uncertain',
      }))
  }

  const growLibrary = (to: number) =>
    env.set(
      updateFolder(env.get(), (f) => ({
        ...f,
        libraryCount: Math.max(f.libraryCount, to),
        cachedCount: Math.max(f.cachedCount, to),
      })),
    )

  const stop = (): void => {
    const status = done > 0 || previousStatus !== 'none' ? 'partial' : 'none'
    env.set(updateFolder(env.get(), (f) => ({ ...f, scan: { ...f.scan, status } })))
  }

  return {
    steps: boundaries.length,
    started: () => ({ type: 'started', jobId: env.jobId, total }),
    step: (index) => {
      const from = done
      const to = boundaries[index] ?? total
      done = to
      growLibrary(to)
      const pps = round(PHOTOS_PER_SECOND + (unitHash(`${env.jobId}:${index}`) - 0.5) * 1.6, 1)
      return {
        type: 'progress',
        jobId: env.jobId,
        done: to,
        total,
        fromCache,
        analyzed: Math.max(0, to - fromCache),
        ...tally(photos.slice(0, to)),
        currentFile: photos[to - 1]?.relPath ?? null,
        photosPerSecond: pps,
        etaMs: to >= total ? 0 : Math.round(((total - to) / pps) * 1000),
        recent: recentOf(photos.slice(from, to)),
      }
    },
    finished: () => {
      const durationMs = Math.round((misses * 1000) / SUMMARY_PHOTOS_PER_SECOND)
      const summary: ScanSummary = {
        jobId: env.jobId,
        total,
        fromCache,
        analyzed: misses,
        ...tally(photos),
        durationMs,
      }
      const state = env.get()
      const clock = state.clock + durationMs
      env.set(
        updateFolder({ ...state, clock }, (f) => ({
          ...f,
          cachedCount: total,
          libraryCount: total,
          scan: { status: 'complete', lastSummary: summary, scannedAt: clockText(clock) },
        })),
      )
      return { type: 'finished', ...summary }
    },
    cancelled: () => {
      stop()
      return { type: 'cancelled', jobId: env.jobId, done }
    },
    failed: (error: IpcError) => {
      stop()
      return { type: 'failed', jobId: env.jobId, error }
    },
  }
}
