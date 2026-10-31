import type { PhotoId, PhotoSummary } from '../../ipc/contract'
import { formatCount } from '../../lib/format'
import { DataText } from '../../components/ui/DataText'
import { ReviewQueue } from './ReviewQueue'

/** The result strip's frames: larger than the queue's, so the marks read as the outcome (critique round 4, P2-14). */
const RESULT_CELL = 72

interface ReviewDoneProps {
  list: readonly PhotoSummary[]
  base: string
  announce: string
  /** The last photo decided: its mark is written with the pen as the result appears. */
  justDecided?: PhotoId | null
}

/**
 * Every unsure photo has a call, and the film is the result: a centred
 * contact strip of what was kept (ticks) and left out (strikes) under a short
 * summary. With nothing to review, the same composition says so. The
 * toolbar's Continue plate (⌘↩) is the one way on; it waits, so the summary
 * can be read (QA batch 3).
 */
export function ReviewDone({ list, base, announce, justDecided = null }: ReviewDoneProps) {
  const total = list.length
  const kept = list.filter((p) => p.review === 'confirmed').length
  return (
    <div className="review-done">
      {total === 0 ? (
        <div className="done-head">
          <h2>Nothing needed your eye</h2>
          <p>The scan was sure about every photo it read.</p>
        </div>
      ) : (
        <>
          <div className="done-head">
            <h2>{total === 1 ? 'All looked at' : `All ${formatCount(total)} looked at`}</h2>
            <DataText as="p" className="done-summary">
              {`${formatCount(kept)} kept, ${formatCount(total - kept)} left out. You can change any of them later from Days or the library.`}
            </DataText>
          </div>
          <ReviewQueue list={list} currentId={null} base={base} label="Reviewed photos" cell={RESULT_CELL} justDecided={justDecided} />
        </>
      )}
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>
    </div>
  )
}
