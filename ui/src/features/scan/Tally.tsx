import { StrikeMark, TickMark } from '../../components/ui/Mark'
import { formatCount } from '../../lib/format'
import type { TallyItem, TallyKind } from './scanModel'

/** Each item's glyph: a filled, ringed, hollow or hatched dot, or the chinagraph tick and strike for your review decisions. */
function Glyph({ kind }: { kind: TallyKind }) {
  if (kind === 'kept') return <TickMark className="g-mark" />
  if (kind === 'leftOut') return <StrikeMark className="g-mark" />
  return <i className={`g g-${kind}`} aria-hidden="true" />
}

/** The tally line under the Scan statement: a glyph, the count in the data font, then words. */
export function Tally({ items }: { items: readonly TallyItem[] }) {
  return (
    <p className="tally">
      {items.map((t) => (
        <span key={t.kind} data-kind={t.kind}>
          <Glyph kind={t.kind} />
          <span className="mono">{formatCount(t.count)}</span> {t.label}
        </span>
      ))}
    </p>
  )
}
