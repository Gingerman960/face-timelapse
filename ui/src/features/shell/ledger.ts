import type { JobKind, SessionSnapshot, VideoSettings } from '../../ipc/contract'
import { countOf, formatCount, formatDuration, formatLength } from '../../lib/format'
import { formatPace, videoTiming } from '../../lib/pace'
import { isReachable, type Step } from '../../lib/steps'

/** ARCHITECTURE §7.3: levelling applies only when |autoRotationDeg − rotation| > 0.3°; within it the eyes read as level. */
export const LEVEL_TOLERANCE_DEG = 0.3

/**
 * The tilt left in the reference as it is rotated now: `autoRotationDeg` is
 * absolute (the rotation that levels the eyes), so what remains is the
 * difference. Null when there is no estimate.
 */
export function residualTilt(rotationDeg: number, autoRotationDeg: number | null): number | null {
  return autoRotationDeg === null ? null : autoRotationDeg - rotationDeg
}

/** True when the reference's eyes are level enough not to mention it. */
export function eyesLevel(rotationDeg: number, autoRotationDeg: number | null): boolean {
  return autoRotationDeg === null || Math.abs(autoRotationDeg - rotationDeg) <= LEVEL_TOLERANCE_DEG
}

export type LedgerId = 'setup' | 'scan' | 'review' | 'days' | 'timelapse'
export type LedgerStatus = 'done' | 'ready' | 'running' | 'attention' | 'locked'

export interface LedgerRow {
  id: LedgerId
  label: string
  /** The step a click opens. */
  step: Step
  status: LedgerStatus
  text: string
  /** 0..1 while a job on this row runs. */
  progress: number | null
  reachable: boolean
  shortcut: string
}

/** Live numbers of the running job, from the jobs store. */
export interface LiveJob {
  kind: JobKind
  done: number
  total: number
  etaMs: number | null
}

const LABELS: Record<LedgerId, string> = {
  setup: 'Reference',
  scan: 'Scan',
  review: 'Review',
  days: 'Days',
  timelapse: 'Timelapse',
}

/** Which ledger row a step lights up (align lives on the Timelapse row). */
export function ledgerIdForStep(step: Step): LedgerId {
  return step === 'align' ? 'timelapse' : step
}

function ratio(job: LiveJob): number {
  return job.total > 0 ? Math.min(1, job.done / job.total) : 0
}

function etaText(job: LiveJob): string {
  return job.etaMs === null ? 'estimating…' : `${formatDuration(job.etaMs)} left`
}

function referenceRow(s: SessionSnapshot): Pick<LedgerRow, 'status' | 'text'> {
  const ref = s.reference
  if (!ref) return { status: 'ready', text: 'Not set yet' }
  if (!ref.detection) return { status: 'attention', text: 'No face in the crop' }
  const aspect = ref.aspect === 'free' ? 'Free crop' : ref.aspect
  const level = eyesLevel(ref.image.rotationDeg, ref.image.autoRotationDeg)
  return { status: 'done', text: `${aspect} · ${level ? 'eyes level' : 'tilted'}` }
}

function scanRow(s: SessionSnapshot, job: LiveJob | null): Pick<LedgerRow, 'status' | 'text' | 'progress'> {
  if (job?.kind === 'scan') return { status: 'running', text: `${Math.round(ratio(job) * 100)}% · ${etaText(job)}`, progress: ratio(job) }
  if (!s.reference?.detection || !s.folder) return { status: 'locked', text: 'Waiting for setup', progress: null }
  // A finished scan with no results (lost to missing models, N5) claims nothing: it reads as ready.
  if (s.scan.status === 'complete' && s.counts.total > 0) return { status: 'done', text: `${formatCount(s.counts.confirmed)} matched`, progress: null }
  if (s.scan.status === 'partial') return { status: 'ready', text: 'Stopped part-way · resume', progress: null }
  return { status: 'ready', text: `Ready · ${countOf(s.folder.imageCount, 'photo')}`, progress: null }
}

/** What the UI already knows ahead of the session (e.g. review decisions still being batched). */
/** Client-side state the ledger shows ahead of the session. */
export interface LedgerOptimism {
  /** Review decisions not yet saved. */
  reviewPending?: number
  /** The video settings in effect (QA N4), when they differ from the session's last export. */
  video?: VideoSettings
}


function reviewRow(s: SessionSnapshot, job: LiveJob | null, optimism: LedgerOptimism): Pick<LedgerRow, 'status' | 'text'> {
  if (job?.kind === 'scan') return { status: 'locked', text: 'After the scan' }
  if (s.scan.status !== 'complete') return { status: 'locked', text: 'After the scan' }
  const { uncertain } = s.counts
  const reviewPending = optimism.reviewPending ?? s.counts.reviewPending
  if (uncertain === 0) return { status: 'locked', text: 'Nothing unsure' }
  if (reviewPending > 0) return { status: 'attention', text: `${formatCount(reviewPending)} of ${formatCount(uncertain)} left` }
  return { status: 'done', text: uncertain === 1 ? '1 looked at' : `All ${formatCount(uncertain)} looked at` }
}

function daysRow(s: SessionSnapshot): Pick<LedgerRow, 'status' | 'text'> {
  if (s.scan.status !== 'complete') return { status: 'locked', text: 'After the scan' }
  return { status: 'done', text: `${countOf(s.counts.activeDays, 'day')} chosen` }
}

function timelapseRow(s: SessionSnapshot, job: LiveJob | null, video: VideoSettings): Pick<LedgerRow, 'status' | 'text' | 'progress'> {
  // Aligning reads like the scan row, "44% · 1 min 21 s left", short enough not to truncate (critique round 4).
  if (job?.kind === 'align') return { status: 'running', text: `${Math.round(ratio(job) * 100)}% · ${etaText(job)}`, progress: ratio(job) }
  if (job?.kind === 'exportVideo' || job?.kind === 'exportImages') {
    return { status: 'running', text: `${job.kind === 'exportVideo' ? 'Encoding' : 'Saving'} · ${etaText(job)}`, progress: ratio(job) }
  }
  const { frames } = s
  // Stale frames report count 0 (none match the current fingerprint), so check stale first.
  // Short enough for the row (critique round 2): "Re-align 3,578".
  // Nothing to re-align (no days chosen yet): the row reads like any timelapse not made yet, never "Re-align 0" (QA).
  if (frames.status === 'stale' && frames.expected > 0) return { status: 'attention', text: `Re-align ${formatCount(frames.expected)}`, progress: null }
  if (frames.count === 0) return { status: 'locked', text: s.scan.status === 'complete' ? 'Align from Days' : 'After the days', progress: null }
  if (frames.status === 'partial') {
    return { status: 'attention', text: `${formatCount(frames.count)} of ${formatCount(frames.expected)} aligned`, progress: null }
  }
  const timing = videoTiming(video, frames.count)
  const length = formatLength(timing?.durationSecs ?? 0)
  return { status: 'done', text: timing ? `${length} · ${formatPace(timing.daysPerSecond)}` : length, progress: null }
}

/** The five ledger rows: what each stage holds now, and whether it can be opened. */
export function deriveLedger(s: SessionSnapshot, job: LiveJob | null, optimism: LedgerOptimism = {}): LedgerRow[] {
  const ref = referenceRow(s)
  const scan = scanRow(s, job)
  const review = reviewRow(s, job, optimism)
  const days = daysRow(s)
  const tl = timelapseRow(s, job, optimism.video ?? s.video)
  const alignRunning = job?.kind === 'align'
  // The cached snapshot can lag the job store by a refetch; a live job keeps its row open.
  const scanRunning = job?.kind === 'scan'
  return [
    { id: 'setup', label: LABELS.setup, step: 'setup', ...ref, progress: null, reachable: true, shortcut: '⌘1' },
    { id: 'scan', label: LABELS.scan, step: 'scan', ...scan, reachable: scanRunning || isReachable('scan', s), shortcut: '⌘2' },
    { id: 'review', label: LABELS.review, step: 'review', ...review, progress: null, reachable: isReachable('review', s), shortcut: '⌘3' },
    { id: 'days', label: LABELS.days, step: 'days', ...days, progress: null, reachable: isReachable('days', s), shortcut: '⌘4' },
    {
      id: 'timelapse',
      label: LABELS.timelapse,
      step: alignRunning ? 'align' : 'timelapse',
      ...tl,
      reachable: alignRunning || isReachable('timelapse', s),
      shortcut: '⌘5',
    },
  ]
}
