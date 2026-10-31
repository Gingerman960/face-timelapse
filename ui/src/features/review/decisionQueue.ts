import type { PhotoId, ReviewDecision } from '../../ipc/contract'

/** DESIGN.md (Review): decisions go to the backend after this much idle time. */
export const REVIEW_BATCH_IDLE_MS = 300

export interface DecisionQueueDeps {
  /** Sends one batch (all photos with the same decision). */
  send: (ids: PhotoId[], decision: ReviewDecision) => Promise<unknown>
  /** Shows a decision immediately (optimistic cache write). */
  apply: (ids: readonly PhotoId[], decision: ReviewDecision) => void
  /** Called once nothing is queued or in flight: re-read the photo list and the days. */
  settle: () => void
  /** A batch failed; `rolledBack` are its photos now shown as before (not those decided again meanwhile). */
  onError: (error: unknown, rolledBack: readonly PhotoId[]) => void
  /** What the photo currently shows (its state before this queue touched it). */
  current: (id: PhotoId) => ReviewDecision
}

export interface DecisionQueue {
  decide: (ids: readonly PhotoId[], decision: ReviewDecision) => void
  /** Sends everything queued now (e.g. when the screen unmounts). */
  flush: () => Promise<void>
}

/**
 * Optimistic, batched review decisions. Each photo remembers the last state
 * the backend confirmed, so a failed batch rolls back to it; the list is only
 * re-read once nothing is queued or in flight, so a refetch can never bring
 * back a photo the user has already decided.
 */
export function createDecisionQueue(deps: DecisionQueueDeps): DecisionQueue {
  let queued = new Map<PhotoId, ReviewDecision>()
  const confirmed = new Map<PhotoId, ReviewDecision>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, REVIEW_BATCH_IDLE_MS)
  }

  const sendBatch = async (batch: Map<PhotoId, ReviewDecision>): Promise<void> => {
    const groups = new Map<ReviewDecision, PhotoId[]>()
    for (const [id, decision] of batch) groups.set(decision, [...(groups.get(decision) ?? []), id])
    for (const [decision, ids] of groups) {
      try {
        await deps.send(ids, decision)
        for (const id of ids) confirmed.set(id, decision)
      } catch (error) {
        // Only roll back photos the user hasn't decided again meanwhile.
        const rolledBack = ids.filter((id) => !queued.has(id))
        for (const id of rolledBack) deps.apply([id], confirmed.get(id) ?? 'pending')
        deps.onError(error, rolledBack)
      }
    }
  }

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (inFlight) await inFlight
    if (queued.size === 0) return
    const batch = queued
    queued = new Map()
    inFlight = sendBatch(batch).finally(() => {
      inFlight = null
    })
    await inFlight
    if (queued.size === 0 && !timer) deps.settle()
  }

  return {
    decide(ids, decision) {
      for (const id of ids) {
        if (!confirmed.has(id) && !queued.has(id)) confirmed.set(id, deps.current(id))
        queued.set(id, decision)
      }
      deps.apply(ids, decision)
      schedule()
    },
    flush,
  }
}
