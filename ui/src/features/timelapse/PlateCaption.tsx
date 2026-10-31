import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import type { FrameSummary } from '../../ipc/contract'
import { formatShortDate, weekdayOf } from '../../lib/dates'
import { formatZone } from '../../lib/format'
import { DataText } from '../../components/ui/DataText'
import { Popover } from '../../components/ui/Overlays'
import { PlayheadText } from './PlayheadText'
import { FIT_LOOSE, FIT_TIGHT, WEDGE_FROM_ZONE, exposureChange, fitBand, fitScaleAt, fitWords, framesLine, zoneSpeech } from './timelapseModel'

/** Zone scale steps on the wedge (zones 0–X). */
const ZONES = 11

/** Left offset of a zone marker on the wedge, in percent. */
function zoneLeft(zone: number): string {
  return `${((Math.max(0, Math.min(ZONES - 1, zone)) + 0.5) / ZONES) * 100}%`
}

/** The playhead's year and day key's year are the same text: "2016". */
function yearOf(day: string): string {
  return day.slice(0, 4)
}

/** A wedge marker: hollow for where the exposure was, solid for where evening put it. */
function ZoneMark({ zone, from }: { zone: number; from?: boolean }) {
  return (
    <svg className={from ? 'zone-mark from' : 'zone-mark'} viewBox="0 0 8 7" style={{ left: zoneLeft(zone) }} aria-hidden="true">
      <path d="M4 0.75 L7.25 6.25 H0.75 Z" />
    </svg>
  )
}

/**
 * The zone wedge (critique round 4, item 24): an absolute Zone System strip
 * with a hollow "from" and a solid "to" marker, labelled in words first,
 * "From zone 5 to 5⅔", its numbers in the data font (round 5, P2-12).
 */
function ZoneWedge({ ev }: { ev: number }) {
  return (
    <div className="zone">
      <div className="zone-wedge" role="img" aria-label={zoneSpeech(ev)}>
        {Array.from({ length: ZONES }, (_, i) => (
          <i key={i} />
        ))}
        <ZoneMark zone={WEDGE_FROM_ZONE} from />
        <ZoneMark zone={WEDGE_FROM_ZONE + ev} />
      </div>
      <span className="zone-label meta" aria-hidden="true">
        From zone <span className="digits">{formatZone(WEDGE_FROM_ZONE)}</span> to <span className="digits">{formatZone(WEDGE_FROM_ZONE + ev)}</span>
      </span>
    </div>
  )
}

/** "Brightened ⅔ stop" over the wedge: the words, then the size in the data font, then its unit. */
function ExposureLine({ ev }: { ev: number }) {
  const { words, amount, unit } = exposureChange(ev)
  return (
    <p className="meta">
      {words}
      {amount ? (
        <>
          {' '}
          <span className="digits">{amount}</span> {unit}
        </>
      ) : null}
    </p>
  )
}

/** What the fit means, for the popover: the median and the band edges in px. */
function FitHelp({ residualPx, medianPx, titleId }: { residualPx: number; medianPx: number; titleId: string }) {
  const band = fitBand(residualPx, medianPx)
  return (
    <>
      <h3 id={titleId}>How well this day lines up</h3>
      <DataText as="p" className="fit-help">{`After aligning, this day’s eyes, nose and mouth sit ${residualPx.toFixed(1)} px from the reference’s, on average.`}</DataText>
      {band ? (
        <DataText as="p" className="popover-help">
          {`Tightly lined up is within ${FIT_TIGHT}× the median of all frames (${(medianPx * FIT_TIGHT).toFixed(1)} px); loosely, beyond ${FIT_LOOSE}× (${(medianPx * FIT_LOOSE).toFixed(1)} px). The Sheet marks the loose ones.`}
        </DataText>
      ) : null}
    </>
  )
}

/**
 * "Tightly lined up · 4.6 px" (critique round 5, P2-12: words first, then the
 * units) beside a three-band scale like Review's Likeness (round 4, item 19):
 * tight up to 1.5× the median fit, ok up to 3×, loose beyond (the sheet's
 * outliers, in safelight). The line is a button: its explanation is a popover
 * the keyboard reaches, not a `title`.
 */
function FitLine({ residualPx, medianPx }: { residualPx: number; medianPx: number }) {
  const band = fitBand(residualPx, medianPx)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const anchor = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  return (
    <>
      <button ref={anchor} type="button" className="cap-fit" data-band={band ?? undefined} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="fit-text">
          <span className="fit-words">{fitWords(band)}</span> · <span className="digits">{residualPx.toFixed(1)}</span> px
        </span>
        {band ? (
          <span className="fit-scale" aria-hidden="true">
            <i />
            <i />
            <i />
            <b style={{ left: `${fitScaleAt(residualPx, medianPx) * 100}%` }} />
          </span>
        ) : null}
      </button>
      <Popover anchor={anchor} open={open} onClose={close} labelledBy={titleId} placement="above-start" width={300}>
        <FitHelp residualPx={residualPx} medianPx={medianPx} titleId={titleId} />
      </Popover>
    </>
  )
}

interface CaptionProps {
  /** Every frame: the date, year and weekday follow the playhead through them at frame rate. */
  frames: readonly FrameSummary[]
  /** The frame at the settled playhead (facts, fit and look). */
  frame: FrameSummary | undefined
  index: number
  count: number
  medianResidual: number
  lookOn: boolean
  /** The Look pair (Onion skin and Even light), beside the zone wedge. */
  look: ReactNode
}

/**
 * The photobook plate beside the frame: the date at hero size, the year and
 * weekday (written at frame rate, PlayheadText), then one facts line, the fit,
 * and the Look pair with the zone wedge when the light is evened (critique
 * round 4, P1-2). The facts follow the settled playhead.
 */
export function PlateCaption({ frames, frame, index, count, medianResidual, lookOn, look }: CaptionProps) {
  if (!frame) return <div className="plate-caption" />
  const evened = lookOn && frame.lookDelta
  const ev = frame.lookDelta?.exposureEv ?? 0
  return (
    <div className="plate-caption">
      <PlayheadText className="cap-date" frames={frames} format={formatShortDate} />
      <PlayheadText className="cap-year" frames={frames} format={yearOf} />
      <PlayheadText className="cap-sub" frames={frames} format={weekdayOf} />
      <div className="cap-facts">
        <DataText as="p" className="meta cap-line">
          {framesLine(index, count)}
        </DataText>
        <FitLine residualPx={frame.residualPx} medianPx={medianResidual} />
      </div>
      <div className="cap-look" role="group" aria-label="Look">
        {look}
        {evened ? (
          <div className="cap-evened">
            <ExposureLine ev={ev} />
            <ZoneWedge ev={ev} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
