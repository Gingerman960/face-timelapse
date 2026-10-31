import { Check, StackSimple, X } from '@phosphor-icons/react'
import type { DayKey, PhotoDetail, PhotoId, PhotoSummary, Point } from '../../ipc/contract'
import { formatDayShort, knownTime } from '../../lib/dates'
import { Facts } from '../../components/ui/Controls'
import { Candidate, type ShownPrint } from './Candidate'
import { Likeness } from './Likeness'
import { RetryImg } from '../../components/ui/RetryImg'
import { DataText } from '../../components/ui/DataText'

const DATE_SOURCE: Record<PhotoSummary['dateSource'], string> = { exif: 'EXIF', filename: 'File name', fileTime: 'File date', manual: 'Set by hand' }

interface ReviewStageProps {
  /** The reference photo's day (from its file name), for its caption; null when unknown. */
  referenceDay: DayKey | null
  photo: PhotoSummary
  detail: PhotoDetail | undefined
  /** True while the detail is on its way (the outgoing print holds). */
  detailPending?: boolean
  /** The photo just decided (its print left as the verdict). */
  justDecided?: PhotoId | null
  /** Told which print is on show, for the verdict to lift. */
  onShown?: (shown: ShownPrint | null) => void
  refAnchors: Point[] | null
  base: string
  referenceFrameUrl: string | null
  compare: boolean
  busy: boolean
  onDecide: (review: 'confirmed' | 'rejected') => void
  onToggleCompare: () => void
}

/** Eye line of the reference frame, 0..1 from the top (mean of the two eye anchors). */
function eyeLine(anchors: Point[] | null): number | null {
  const [l, r] = anchors ?? []
  return l && r ? (l.y + r.y) / 2 : null
}

/**
 * The comparison (QA M9): the reference and the aligned candidate at the same
 * height on a shared top edge, so their eyes sit on one 0.5 px guide line run
 * across both; then the three decision buttons right under the prints
 * (critique round 2: no dead band). They are weighted by intent (critique
 * round 3): Keep is the screen's primary (the ink plate), Leave out the
 * secondary (raised), Compare a tertiary hairline toggle, each with its key.
 * Both prints are captioned alike, a label and a date; the queue below
 * carries the only counter.
 */
export function ReviewStage(props: ReviewStageProps) {
  const { photo, compare, busy, onDecide, onToggleCompare } = props
  const eye = eyeLine(props.refAnchors)
  // A moved photo's time belongs to another day; without a known time, the date says it all.
  const time = photo.dateSource === 'manual' ? null : knownTime(photo)
  return (
    <div className="review-stage">
      <div className="pair" style={eye === null ? undefined : { ['--eye' as string]: eye }}>
      <figure className="review-ref">
        <div className="pair-frame">
          {props.referenceFrameUrl ? <RetryImg src={props.referenceFrameUrl} alt="Reference" /> : null}
        </div>
        <figcaption>
          <span className="label-caps">Reference</span>
          <span className="when">{props.referenceDay ? formatDayShort(props.referenceDay) : null}</span>
        </figcaption>
      </figure>
      <figure className="candidate">
        <Candidate
          photo={photo}
          detail={props.detail}
          detailPending={props.detailPending}
          justDecided={props.justDecided}
          onShown={props.onShown}
          refAnchors={props.refAnchors}
          base={props.base}
          referenceFrameUrl={props.referenceFrameUrl}
          compare={compare}
          alt={`Unsure match from ${formatDayShort(photo.dayKey)}`}
        />
        <figcaption>
          <span className="label-caps">Unsure match</span>
          <span className="when">
            {formatDayShort(photo.dayKey)}
            {time ? <span className="mono-meta"> · {time}</span> : null}
          </span>
        </figcaption>
      </figure>
      {eye === null ? null : <i className="eye-line" aria-hidden="true" />}
      </div>
      <div className="decide" role="group" aria-label="Decide">
        <button type="button" className="btn-decide reject" onClick={() => onDecide('rejected')} disabled={busy}>
          <X className="icon" aria-hidden="true" />
          Leave out <kbd aria-hidden="true">N</kbd>
        </button>
        <button type="button" className="btn-decide compare" aria-pressed={compare} onClick={onToggleCompare}>
          <StackSimple className="icon" aria-hidden="true" />
          Compare <kbd aria-hidden="true">Space</kbd>
        </button>
        <button type="button" className="btn-decide keep" onClick={() => onDecide('confirmed')} disabled={busy}>
          <Check className="icon" aria-hidden="true" />
          Keep <kbd aria-hidden="true">Y</kbd>
        </button>
      </div>
    </div>
  )
}

/** The faces fact in words (critique round 4, item 19): "One face", "2 faces · best match used". */
export function facesFact(detail: PhotoDetail | undefined): string {
  if (!detail) return '…'
  const n = detail.faces.length
  if (n === 0) return 'No face'
  return n === 1 ? 'One face' : `${n} faces · best match used`
}

/** Why the scan wasn't sure: the likeness score, the file and the keys. */
export function ReviewFacts({ photo, detail }: { photo: PhotoSummary; detail: PhotoDetail | undefined }) {
  const faces = facesFact(detail)
  return (
    <aside className="review-facts" aria-label="Match details">
      <section>
        <h2 className="label-caps">Likeness</h2>
        <Likeness score={photo.score} />
      </section>
      <Facts
        rows={[
          { label: 'File', value: photo.fileName },
          { label: 'Faces', value: <DataText className="tabular">{faces}</DataText>, mono: false },
          { label: 'Date from', value: DATE_SOURCE[photo.dateSource], mono: false },
        ]}
      />
      <div className="keys">
        <h2 className="label-caps">Keys</h2>
        <p>
          <kbd>Y</kbd> or <kbd>→</kbd> keep
        </p>
        <p>
          <kbd>N</kbd> or <kbd>←</kbd> leave out
        </p>
        <p>
          <kbd>Space</kbd> hold to compare
        </p>
        <p>
          <kbd>U</kbd> undo the last call
        </p>
        <p>
          <kbd>⇧A</kbd> keep all remaining
        </p>
      </div>
    </aside>
  )
}
