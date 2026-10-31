import { useEffect, useMemo } from 'react'
import type { PhotoId, PhotoSummary, ReviewDecision } from '../../ipc/contract'
import { reportError, setReviewDecision } from '../../state/actions'
import { dayPoolChanged, queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'
import { createDecisionQueue, type DecisionQueue } from './decisionQueue'

export const UNCERTAIN = ['uncertain'] as const
const uncertainKey = () => queryKeys.photos([...UNCERTAIN])

function showDecision(ids: readonly PhotoId[], review: ReviewDecision): void {
  // A refetch already on its way would overwrite this with older data.
  void queryClient.cancelQueries({ queryKey: queryKeys.photosAll })
  const set = new Set(ids)
  queryClient.setQueryData<PhotoSummary[]>(uncertainKey(), (prev) =>
    prev?.map((p) => (set.has(p.id) ? { ...p, review, included: review === 'confirmed' } : p)),
  )
}

function shownDecision(id: PhotoId): ReviewDecision {
  return queryClient.getQueryData<PhotoSummary[]>(uncertainKey())?.find((p) => p.id === id)?.review ?? 'pending'
}

/**
 * Review decisions for this screen: shown at once, sent in batches after
 * 300 ms idle (rolled back if a batch fails), and flushed when the screen
 * goes away. The photo list and days are re-read once, after the last batch.
 */
export function useReviewDecisions(): DecisionQueue {
  const queue = useMemo(
    () =>
      createDecisionQueue({
        send: (ids, decision) => setReviewDecision(ids, decision, { refresh: false }),
        apply: showDecision,
        settle: dayPoolChanged,
        onError: (error, rolledBack) => {
          useView.getState().dropReviewUndo(rolledBack)
          reportError(error)
        },
        current: shownDecision,
      }),
    [],
  )
  useEffect(
    () => () => {
      void queue.flush()
    },
    [queue],
  )
  return queue
}
