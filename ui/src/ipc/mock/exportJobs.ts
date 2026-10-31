// Export jobs: image files (YYYYMMDD.ext with the `_1` suffix rule) and video.
import type { ExportImagesEvent, ExportVideoEvent, ImageExportSettings, IpcError } from '../contract'
import { framesOf } from './frames'
import { type JobScript, chunkBoundaries } from './jobs'
import { round, unitHash } from './random'
import type { JobEnv } from './scanJob'
import type { MockState } from './state'
import type { VideoPlan } from './videoPlan'

const IMAGES_PER_SECOND = 85
const ENCODE_FPS = 45

/** File names for the frames, in order; `_1`, `_2`, … when a name is taken and overwrite is off. */
export function exportNames(
  dayKeys: readonly string[],
  settings: ImageExportSettings,
  existing: readonly string[],
): { names: string[]; renamed: number } {
  const ext = settings.format === 'png' ? 'png' : 'jpg'
  const taken = new Set(settings.overwrite ? [] : existing)
  const names: string[] = []
  let renamed = 0
  for (const dayKey of dayKeys) {
    const base = dayKey.replaceAll('-', '')
    let name = `${base}.${ext}`
    for (let n = 1; taken.has(name); n++) name = `${base}_${n}.${ext}`
    if (name !== `${base}.${ext}`) renamed += 1
    taken.add(name)
    names.push(name)
  }
  return { names, renamed }
}

function recordWritten(state: MockState, dir: string, names: readonly string[]): MockState {
  if (names.length === 0) return state
  const previous = state.exported[dir] ?? []
  return {
    ...state,
    exported: { ...state.exported, [dir]: [...new Set([...previous, ...names])] },
    outputs: state.outputs.includes(dir) ? state.outputs : [...state.outputs, dir],
  }
}

export function exportImagesScript(env: JobEnv, dir: string, settings: ImageExportSettings): JobScript<ExportImagesEvent> {
  const start = env.get()
  const dayKeys = framesOf(start).frames.map((f) => f.dayKey)
  const { names, renamed } = exportNames(dayKeys, settings, start.exported[dir] ?? [])
  const total = names.length
  const boundaries = chunkBoundaries(total, env.steps)
  let done = 0
  return {
    steps: boundaries.length,
    started: () => ({ type: 'started', jobId: env.jobId, total }),
    step: (index) => {
      const from = done
      const to = boundaries[index] ?? total
      done = to
      env.set(recordWritten(env.get(), dir, names.slice(from, to)))
      return {
        type: 'progress',
        jobId: env.jobId,
        done: to,
        total,
        currentFile: names[to - 1] ?? null,
        etaMs: to >= total ? 0 : Math.round(((total - to) / IMAGES_PER_SECOND) * 1000),
      }
    },
    finished: () => {
      const durationMs = Math.round((total * 1000) / IMAGES_PER_SECOND)
      const state = env.get()
      env.set({ ...state, clock: state.clock + durationMs })
      return { type: 'finished', jobId: env.jobId, dir, written: total, renamed, durationMs }
    },
    cancelled: () => ({ type: 'cancelled', jobId: env.jobId, done }),
    failed: (error: IpcError) => ({ type: 'failed', jobId: env.jobId, error }),
  }
}

export function exportVideoScript(env: JobEnv, path: string, plan: VideoPlan): JobScript<ExportVideoEvent> {
  const boundaries = chunkBoundaries(plan.framesTotal, env.steps)
  let done = 0
  const discard = () => {
    const state = env.get()
    if (!state.outputs.includes(path) && !state.discarded.includes(path)) {
      env.set({ ...state, discarded: [...state.discarded, path] })
    }
  }
  return {
    steps: boundaries.length,
    started: () => ({ type: 'started', jobId: env.jobId, total: plan.framesTotal }),
    step: (index) => {
      done = boundaries[index] ?? plan.framesTotal
      const encodeFps = round(ENCODE_FPS + (unitHash(`${env.jobId}:${index}`) - 0.5) * 3, 1)
      return {
        type: 'progress',
        jobId: env.jobId,
        framesDone: done,
        framesTotal: plan.framesTotal,
        encodeFps,
        etaMs: done >= plan.framesTotal ? 0 : Math.round(((plan.framesTotal - done) / encodeFps) * 1000),
      }
    },
    finished: () => {
      const elapsedMs = Math.round((plan.framesTotal * 1000) / ENCODE_FPS)
      const state = env.get()
      env.set({
        ...state,
        clock: state.clock + elapsedMs,
        outputs: state.outputs.includes(path) ? state.outputs : [...state.outputs, path],
        discarded: state.discarded.filter((p) => p !== path),
      })
      return {
        type: 'finished',
        jobId: env.jobId,
        path,
        frames: plan.framesTotal,
        durationSecs: plan.durationSecs,
        bytes: plan.bytes,
        elapsedMs,
      }
    },
    cancelled: () => {
      discard()
      return { type: 'cancelled', jobId: env.jobId, done }
    },
    failed: (error: IpcError) => {
      discard()
      return { type: 'failed', jobId: env.jobId, error }
    },
  }
}
