// Align job: renders (or reuses) one frame per active day, chronologically,
// writing masters under the current fingerprint as it goes.
import type { AlignEvent, AlignFailure, AlignRecent, IpcError, PhotoId } from '../contract'
import { decodeFailed } from './errors'
import { type ActiveFrame, adjustOf, fingerprintOf, framesOf, frameVersionOf, outputSizeOf, residualFor } from './frames'
import { type JobScript, chunkBoundaries } from './jobs'
import { hash32, round, unitHash } from './random'
import type { JobEnv } from './scanJob'
import { type FrameRecord, type MockState, omitKey } from './state'

/** Display throughput while rendering. */
const FRAMES_PER_SECOND = 24
const REUSE_MS = 2
const MAX_RECENT = 64
/** Fingerprints kept on "disk" (ARCHITECTURE §5 pruning). */
const KEPT_FINGERPRINTS = 3

/** Photos that will fail: preferably on days with alternates (the user can pick another photo). */
function chooseFailures(active: readonly ActiveFrame[], count: number): ReadonlySet<PhotoId> {
  const candidates = active
    .filter((a) => a.record === null)
    .map((a) => ({ id: a.photoId, alternates: a.day.photoIds.length > 1, key: hash32(`alignFail:${a.photoId}`) }))
    .sort((a, b) => Number(b.alternates) - Number(a.alternates) || a.key - b.key)
  return new Set(candidates.slice(0, Math.max(0, count)).map((c) => c.id))
}

function writeRecords(
  state: MockState,
  fingerprint: string,
  records: Readonly<Record<PhotoId, FrameRecord>>,
): MockState {
  const merged = { ...(state.frames[fingerprint] ?? {}), ...records }
  const others = Object.keys(omitKey(state.frames, fingerprint)).slice(-(KEPT_FINGERPRINTS - 1))
  const frames = Object.fromEntries([
    ...others.map((fp) => [fp, state.frames[fp] ?? {}] as const),
    [fingerprint, merged] as const,
  ])
  return { ...state, frames }
}

export function alignScript(env: JobEnv, failureCount: number): JobScript<AlignEvent> {
  const start = env.get()
  const fingerprint = fingerprintOf(start) ?? ''
  const active = framesOf(start).active
  const total = active.length
  const failing = chooseFailures(active, failureCount)
  const boundaries = chunkBoundaries(total, env.steps)
  const failures: AlignFailure[] = []
  let done = 0
  let reused = 0
  let rendered = 0

  const process = (items: readonly ActiveFrame[]): AlignRecent[] => {
    const state = env.get()
    const written: [PhotoId, FrameRecord][] = []
    const finished: { item: ActiveFrame; record: FrameRecord }[] = []
    for (const item of items) {
      if (failing.has(item.photoId)) {
        failures.push({ photoId: item.photoId, error: decodeFailed(item.fixture.fileName) })
        continue
      }
      const record: FrameRecord = item.record ?? {
        photoVersion: item.fixture.version,
        adjust: adjustOf(state, item.photoId),
        residualPx: residualFor(item.photoId),
      }
      if (item.record) reused += 1
      else {
        rendered += 1
        written.push([item.photoId, record])
      }
      finished.push({ item, record })
    }
    env.set(writeRecords(state, fingerprint, Object.fromEntries(written)))
    return finished.slice(-MAX_RECENT).map(({ item, record }) => ({
      id: item.photoId,
      version: frameVersionOf(state, fingerprint, record.photoVersion, record.adjust),
      dayKey: item.day.dayKey,
    }))
  }

  return {
    steps: boundaries.length,
    started: () => ({ type: 'started', jobId: env.jobId, total }),
    step: (index) => {
      const from = done
      const to = boundaries[index] ?? total
      done = to
      const recent = process(active.slice(from, to))
      const fps = round(FRAMES_PER_SECOND + (unitHash(`${env.jobId}:${index}`) - 0.5) * 2, 1)
      return {
        type: 'progress',
        jobId: env.jobId,
        done: to,
        total,
        reused,
        failed: failures.length,
        currentPhotoId: active[to - 1]?.photoId ?? null,
        framesPerSecond: fps,
        etaMs: to >= total ? 0 : Math.round(((total - to) / fps) * 1000),
        recent,
      }
    },
    finished: () => {
      const durationMs = Math.round((rendered * 1000) / FRAMES_PER_SECOND + reused * REUSE_MS)
      const state = env.get()
      env.set({ ...state, clock: state.clock + durationMs })
      return {
        type: 'finished',
        jobId: env.jobId,
        total,
        rendered,
        reused,
        failed: failures.slice(),
        outputSize: outputSizeOf(state) ?? { width: 0, height: 0 },
        durationMs,
      }
    },
    cancelled: () => ({ type: 'cancelled', jobId: env.jobId, done }),
    failed: (error: IpcError) => ({ type: 'failed', jobId: env.jobId, error }),
  }
}
