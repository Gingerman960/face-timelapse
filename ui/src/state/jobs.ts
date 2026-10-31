import { create } from 'zustand'
import { call, runJob, toIpcError, type JobOutcome } from '../ipc/client'
import { inContext } from '../ipc/errors'
import { withModelsNote } from './models'
import type {
  ActiveJob,
  AlignEvent,
  AlignProgress,
  AlignRecent,
  AlignSummary,
  ExportImagesEvent,
  ExportImagesSummary,
  ExportProgress,
  ExportVideoEvent,
  ImageExportSettings,
  IpcError,
  JobId,
  JobKind,
  RenderSettings,
  ScanEvent,
  ScanProgress,
  ScanRecent,
  ScanSummary,
  SessionSnapshot,
  VideoProgress,
  VideoSettings,
  VideoSummary,
} from '../ipc/contract'
import { stepAfterJob } from '../lib/steps'
import { reportError } from './actions'
import { queryClient, queryKeys, refreshAll } from './queries'
import { useView } from './view'

interface JobTrack<P, S, R = never> {
  progress: P | null
  total: number
  recent: R[]
  summary: S | null
  error: IpcError | null
  cancelledAt: number | null
}

export interface JobsState {
  activeJobId: JobId | null
  activeKind: JobKind | null
  scan: JobTrack<ScanProgress, ScanSummary, ScanRecent>
  align: JobTrack<AlignProgress, AlignSummary, AlignRecent>
  exportVideo: JobTrack<VideoProgress, VideoSummary>
  exportImages: JobTrack<ExportProgress, ExportImagesSummary>
}

const EMPTY_TRACK = { progress: null, total: 0, recent: [], summary: null, error: null, cancelledAt: null } as const

const emptyTrack = <P, S, R = never>(): JobTrack<P, S, R> => ({
  progress: null,
  total: 0,
  recent: [],
  summary: null,
  error: null,
  cancelledAt: null,
})

export const useJobs = create<JobsState>(() => ({
  activeJobId: null,
  activeKind: null,
  scan: emptyTrack(),
  align: emptyTrack(),
  exportVideo: emptyTrack(),
  exportImages: emptyTrack(),
}))

type TrackKey = 'scan' | 'align' | 'exportVideo' | 'exportImages'

function patchTrack<K extends TrackKey>(key: K, patch: Partial<JobsState[K]>): void {
  useJobs.setState((s) => ({ ...s, [key]: { ...s[key], ...patch } }))
}

const BUSY: IpcError = { kind: 'busy', message: 'Another task is running. Wait for it to finish or cancel it.' }

function rejectIfBusy(): void {
  if (useJobs.getState().activeJobId !== null) throw BUSY
}

async function freshSession(): Promise<SessionSnapshot> {
  await refreshAll()
  return queryClient.fetchQuery({ queryKey: queryKeys.session, queryFn: () => call('get_session') })
}

/**
 * A job ended: re-read the session first (the job still shows as running, so
 * the step router never sees a stale idle state), then clear the job and set
 * the next step in one go. If the session can't be read, the job still ends
 * and the error is shown.
 */
async function afterJob(kind: JobKind, outcome: Outcome, error: IpcError | null = null): Promise<void> {
  let session: SessionSnapshot | null = null
  try {
    session = await freshSession()
  } catch (e) {
    reportError(e)
  }
  useJobs.setState({ activeJobId: null, activeKind: null })
  const next = session ? stepAfterJob(kind, outcome, session) : null
  if (next) useView.getState().setStep(next)
  if (error) useView.getState().pushToast({ message: withModelsNote(error).message, tone: 'stop' })
}

type Outcome = JobOutcome<ScanEvent>['outcome']

/** Ends a tracked job from its terminal event. */
function endJob<E extends { type: string; jobId: JobId }>(kind: JobKind, result: JobOutcome<E>): Promise<void> {
  return afterJob(kind, result.outcome, result.outcome === 'failed' ? result.event.error : null)
}

/*
 * One start at a time (M1): a second start of the same job while the first
 * is still being started (double click, ⌘↩ auto-repeat) joins it instead of
 * wiping its progress and failing with BUSY. A different job is refused.
 */
let starting: { kind: JobKind; promise: Promise<void> } | null = null

function startOnce(kind: JobKind, start: () => Promise<void>): Promise<void> {
  if (starting) {
    if (starting.kind === kind) return starting.promise
    return Promise.reject(BUSY)
  }
  try {
    rejectIfBusy()
  } catch (error) {
    return Promise.reject(error)
  }
  const promise = start().finally(() => {
    starting = null
  })
  starting = { kind, promise }
  return promise
}

/** Starts a scan of the current folder; the Scan screen follows its progress. */
export function startScan(): Promise<void> {
  return startOnce('scan', runScan)
}

async function runScan(): Promise<void> {
  useJobs.setState({ scan: emptyTrack() })
  const job = await runJob<ScanEvent>(
    (onEvent) => call('start_scan', { onEvent }),
    (event) => {
      if (event.type === 'started') patchTrack('scan', { total: event.total })
      else if (event.type === 'progress') {
        const prev = useJobs.getState().scan.recent
        patchTrack('scan', { progress: event, recent: event.recent.length ? [...prev, ...event.recent] : prev })
      } else if (event.type === 'finished') patchTrack('scan', { summary: event })
      else if (event.type === 'failed') patchTrack('scan', { error: withModelsNote(event.error) })
      else patchTrack('scan', { cancelledAt: event.done })
    },
  )
  useJobs.setState({ activeJobId: job.jobId, activeKind: 'scan' })
  useView.getState().setStep('scan')
  void job.done.then((r) => endJob('scan', r)).catch(reportError)
}

/** Starts aligning every active day; the Timelapse screen shows it in its aligning state. */
export function startAlign(render: RenderSettings): Promise<void> {
  return startOnce('align', () => runAlign(render))
}

async function runAlign(render: RenderSettings): Promise<void> {
  useJobs.setState({ align: emptyTrack() })
  const job = await runJob<AlignEvent>(
    (onEvent) => call('start_align', { render, onEvent }),
    (event) => {
      if (event.type === 'started') patchTrack('align', { total: event.total })
      else if (event.type === 'progress') {
        const prev = useJobs.getState().align.recent
        patchTrack('align', { progress: event, recent: event.recent.length ? [...prev, ...event.recent] : prev })
      } else if (event.type === 'finished') patchTrack('align', { summary: event })
      else if (event.type === 'failed') patchTrack('align', { error: withModelsNote(event.error) })
      else patchTrack('align', { cancelledAt: event.done })
    },
  )
  useJobs.setState({ activeJobId: job.jobId, activeKind: 'align' })
  useView.getState().setStep('align')
  void job.done.then(async (r) => {
    await endJob('align', r)
    if (r.outcome === 'cancelled') {
      const total = useJobs.getState().align.total
      useView.getState().pushToast({
        message: `Aligned ${r.event.done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}. Align again to continue.`,
        tone: 'info',
      })
    }
  }).catch(reportError)
}

/** Encodes the timelapse to `path`; the export sheet shows progress in place. */
export function startExportVideo(path: string, settings: VideoSettings): Promise<void> {
  return startOnce('exportVideo', () => runExportVideo(path, settings))
}

async function runExportVideo(path: string, settings: VideoSettings): Promise<void> {
  useJobs.setState({ exportVideo: emptyTrack() })
  const job = await runJob<ExportVideoEvent>(
    (onEvent) => call('start_export_video', { path, settings, onEvent }).catch((e: unknown) => {
      throw inContext(toIpcError(e), 'export')
    }),
    (event) => {
      if (event.type === 'started') patchTrack('exportVideo', { total: event.total })
      else if (event.type === 'progress') patchTrack('exportVideo', { progress: event })
      else if (event.type === 'finished') patchTrack('exportVideo', { summary: event })
      else if (event.type === 'failed') patchTrack('exportVideo', { error: withModelsNote(event.error) })
      else patchTrack('exportVideo', { cancelledAt: event.done })
    },
  )
  useJobs.setState({ activeJobId: job.jobId, activeKind: 'exportVideo' })
  void job.done.then(afterExport).catch(reportError)
}

/** Writes every frame as an image into `dir`. */
export function startExportImages(dir: string, settings: ImageExportSettings): Promise<void> {
  return startOnce('exportImages', () => runExportImages(dir, settings))
}

async function runExportImages(dir: string, settings: ImageExportSettings): Promise<void> {
  useJobs.setState({ exportImages: emptyTrack() })
  const job = await runJob<ExportImagesEvent>(
    (onEvent) => call('start_export_images', { dir, settings, onEvent }).catch((e: unknown) => {
      throw inContext(toIpcError(e), 'export')
    }),
    (event) => {
      if (event.type === 'started') patchTrack('exportImages', { total: event.total })
      else if (event.type === 'progress') patchTrack('exportImages', { progress: event })
      else if (event.type === 'finished') patchTrack('exportImages', { summary: event })
      else if (event.type === 'failed') patchTrack('exportImages', { error: withModelsNote(event.error) })
      else patchTrack('exportImages', { cancelledAt: event.done })
    },
  )
  useJobs.setState({ activeJobId: job.jobId, activeKind: 'exportImages' })
  void job.done.then(afterExport).catch(reportError)
}

async function afterExport(): Promise<void> {
  useJobs.setState({ activeJobId: null, activeKind: null })
  await queryClient.invalidateQueries({ queryKey: queryKeys.session })
}

/* ───────────── Orphan jobs (M2) ─────────────
 * After a webview reload (or a crashed web content process) the backend may
 * still be running a job whose channel belonged to the old page. The session
 * reports it as `activeJob`; the UI adopts it so it shows as running, ⌘.
 * cancels it, and every other action waits. Progress is unknown, so the
 * session is polled until the job is gone. */
const ORPHAN_POLL_MS = 1000
let orphanTimer: ReturnType<typeof setTimeout> | null = null

/** Adopts a job the session reports but this page didn't start. No-op when the UI already tracks a job. */
export function adoptOrphanJob(active: ActiveJob | null): void {
  if (!active || starting || useJobs.getState().activeJobId !== null) return
  useJobs.setState((st) => ({ ...st, activeJobId: active.jobId, activeKind: active.kind, [active.kind]: { ...st[active.kind], ...EMPTY_TRACK } }))
  if (active.kind === 'scan') useView.getState().setStep('scan')
  if (active.kind === 'align') useView.getState().setStep('align')
  pollOrphan(active)
}

function pollOrphan(active: ActiveJob): void {
  if (orphanTimer) clearTimeout(orphanTimer)
  orphanTimer = setTimeout(() => {
    orphanTimer = null
    void call('get_session')
      .then(async (session) => {
        if (useJobs.getState().activeJobId !== active.jobId) return
        if (session.activeJob?.jobId === active.jobId) {
          pollOrphan(active)
          return
        }
        const finished = active.kind === 'scan' ? session.scan.status === 'complete' : active.kind === 'align' ? session.frames.status === 'complete' : true
        if (active.kind === 'exportVideo' || active.kind === 'exportImages') await afterExport()
        else await afterJob(active.kind, finished ? 'finished' : 'cancelled')
      })
      .catch((error: unknown) => {
        reportError(error)
        useJobs.setState({ activeJobId: null, activeKind: null })
      })
  }, ORPHAN_POLL_MS)
}

/** Cancels the running job, if any (⌘.). Partial work is kept by the backend. */
export async function cancelActiveJob(): Promise<void> {
  const { activeJobId } = useJobs.getState()
  if (!activeJobId) return
  try {
    await call('cancel_job', { jobId: activeJobId })
  } catch (error) {
    useView.getState().pushToast({ message: withModelsNote(toIpcError(error)).message, tone: 'stop' })
  }
}

/** Clears a finished export's result so the sheet returns to its settings. */
export function resetExportTracks(): void {
  useJobs.setState({ exportVideo: emptyTrack(), exportImages: emptyTrack() })
}
