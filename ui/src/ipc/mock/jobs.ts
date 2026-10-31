// Job driver for the fake backend: one job at a time (D4), events streamed on
// the job's Channel as `started` → `progress`* → exactly one terminal event.
// Every event is delivered from a timer, never synchronously inside the
// `start_*` handler, so the UI always has the JobId first.
import type { ActiveJob, IpcError, JobId, JobKind } from '../contract'
import type { MockSpeed } from './options'

export interface EventSink<E> {
  onmessage: (event: E) => void
}

/** What a job does at each tick. Methods update backend state, then return the event to send. */
export interface JobScript<E> {
  readonly steps: number
  started(): E
  /** Performs step `index` (0-based) and returns its progress event. */
  step(index: number): E
  finished(): E
  cancelled(): E
  failed(error: IpcError): E
}

export interface JobTiming {
  steps: number
  tickMs: number
}

/** Progress events are throttled to one per tick (≈ 80 ms), like the real backend's ≤ 20/s. */
export const TICK_MS = 80
const INSTANT_STEPS = 4

const DURATIONS_MS: Readonly<Record<JobKind, Readonly<Record<Exclude<MockSpeed, 'instant'>, number>>>> = {
  scan: { fast: 1200, normal: 8000 },
  align: { fast: 1000, normal: 6000 },
  exportImages: { fast: 800, normal: 5000 },
  exportVideo: { fast: 800, normal: 5000 },
}

export function jobTiming(kind: JobKind, speed: MockSpeed): JobTiming {
  if (speed === 'instant') return { steps: INSTANT_STEPS, tickMs: 0 }
  return { steps: Math.max(2, Math.round(DURATIONS_MS[kind][speed] / TICK_MS)), tickMs: TICK_MS }
}

/** Splits `total` items into `steps` cumulative boundaries (last = total). */
export function chunkBoundaries(total: number, steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => Math.round((total * (i + 1)) / steps))
}

interface Running {
  readonly jobId: JobId
  readonly kind: JobKind
  cancelRequested: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  tick: () => void
}

export interface StartOptions {
  timing: JobTiming
  /** Emit `failed` instead of this step's progress (mid-job failure injection). */
  failAt: { step: number; error: IpcError } | null
}

export class JobRunner {
  private running: Running | null = null
  private counter = 0

  get activeJob(): ActiveJob | null {
    return this.running ? { jobId: this.running.jobId, kind: this.running.kind } : null
  }

  start<E>(kind: JobKind, sink: EventSink<E>, makeScript: (jobId: JobId) => JobScript<E>, opts: StartOptions): JobId {
    this.counter += 1
    const jobId = `${kind}-${this.counter}`
    const script = makeScript(jobId)
    const deliver = (event: E) => {
      try {
        sink.onmessage(event)
      } catch (error) {
        console.error('[mock] job event handler threw', error)
      }
    }
    let startedSent = false
    let next = 0
    const job: Running = {
      jobId,
      kind,
      cancelRequested: false,
      timer: undefined,
      tick: () => {
        if (this.running !== job) return
        const finish = (makeEvent: () => E) => {
          const event = makeEvent()
          this.running = null
          deliver(event)
        }
        if (!startedSent) {
          startedSent = true
          deliver(script.started())
        } else if (job.cancelRequested) {
          finish(() => script.cancelled())
          return
        } else if (opts.failAt && next >= opts.failAt.step) {
          const { error } = opts.failAt
          finish(() => script.failed(error))
          return
        } else if (next < script.steps) {
          deliver(script.step(next))
          next += 1
        } else {
          finish(() => script.finished())
          return
        }
        this.schedule(job, job.cancelRequested ? 0 : opts.timing.tickMs)
      },
    }
    this.running = job
    this.schedule(job, 0)
    return jobId
  }

  /** Requests cancellation; the `cancelled` event follows on the next tick. Unknown ids are a no-op. */
  cancel(jobId: JobId): void {
    const job = this.running
    if (!job || job.jobId !== jobId || job.cancelRequested) return
    job.cancelRequested = true
    if (job.timer !== undefined) clearTimeout(job.timer)
    this.schedule(job, 0)
  }

  /** Drops the running job without a terminal event (scenario reload / teardown). */
  dispose(): void {
    if (this.running?.timer !== undefined) clearTimeout(this.running.timer)
    this.running = null
  }

  private schedule(job: Running, ms: number): void {
    job.timer = setTimeout(job.tick, ms)
  }
}
