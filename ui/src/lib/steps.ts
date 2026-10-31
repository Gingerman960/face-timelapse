// ui/src/lib/steps.ts
// Step reachability, startup and auto-enter rules (ARCHITECTURE.md §8, with P6:
// `scan` stays reachable after a scan as the library view).
import type { JobKind, SessionSnapshot } from '../ipc/contract'

export type Step = 'setup' | 'scan' | 'review' | 'days' | 'align' | 'timelapse'
/** Sidebar ledger rows; `align` is shown on the timelapse row. */
export type LedgerRow = Exclude<Step, 'align'>
export type JobOutcome = 'finished' | 'cancelled' | 'failed'

/** Every step in workflow order. */
export const STEPS: readonly Step[] = ['setup', 'scan', 'review', 'days', 'align', 'timelapse']
/** Ledger rows in sidebar order (⌘1–⌘5). */
export const LEDGER_ORDER: readonly LedgerRow[] = ['setup', 'scan', 'review', 'days', 'timelapse']

/** Steps restored at startup only while their job runs. */
const TRANSIENT_JOB: Readonly<Partial<Record<Step, JobKind>>> = { scan: 'scan', align: 'align' }
/** Startup fallback, furthest first. */
const STARTUP_FALLBACK: readonly Step[] = ['timelapse', 'days', 'setup']

/** Type guard for values read back from storage (e.g. `lastStep`). */
export function isStep(value: unknown): value is Step {
  return typeof value === 'string' && (STEPS as readonly string[]).includes(value)
}

/** True while a job of `kind` is running. */
function jobRunning(session: SessionSnapshot, kind: JobKind): boolean {
  return session.activeJob?.kind === kind
}

/** Whether `step` can be shown for this session (§8 table + P6). */
export function isReachable(step: Step, session: SessionSnapshot): boolean {
  switch (step) {
    case 'setup':
      return true
    case 'scan':
      return jobRunning(session, 'scan') || session.scan.status !== 'none'
    case 'review':
      return session.scan.status === 'complete' && session.counts.uncertain > 0
    case 'days':
      return session.scan.status === 'complete'
    case 'align':
      return jobRunning(session, 'align')
    case 'timelapse':
      return session.frames.count > 0
  }
}

/** All reachable steps, in workflow order. */
export function reachableSteps(session: SessionSnapshot): Step[] {
  return STEPS.filter((step) => isReachable(step, session))
}

/** First reachable step of `candidates`, else `setup` (always reachable). */
function firstReachable(candidates: readonly Step[], session: SessionSnapshot): Step {
  return candidates.find((step) => isReachable(step, session)) ?? 'setup'
}

/** Startup step: `lastStep` if reachable (transient ones only while their job runs), else timelapse → days → setup. */
export function startupStep(lastStep: Step | null, session: SessionSnapshot): Step {
  if (lastStep !== null && isReachable(lastStep, session)) {
    const job = TRANSIENT_JOB[lastStep]
    if (job === undefined || jobRunning(session, job)) return lastStep
  }
  return firstReachable(STARTUP_FALLBACK, session)
}

/** Auto-enter after a job's terminal event; null means stay. `session` is the re-queried snapshot. */
export function stepAfterJob(kind: JobKind, outcome: JobOutcome, session: SessionSnapshot): Step | null {
  switch (kind) {
    case 'scan':
      if (outcome !== 'finished') return 'setup'
      return session.counts.reviewPending > 0
        ? firstReachable(['review', 'days', 'scan'], session)
        : firstReachable(['days', 'scan'], session)
    case 'align':
      return outcome === 'finished' ? firstReachable(['timelapse', 'days'], session) : firstReachable(['days'], session)
    case 'exportImages':
    case 'exportVideo':
      return null
  }
}
