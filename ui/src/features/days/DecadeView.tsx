import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react'
import type { DayGroup, DayKey, PhotoSummary } from '../../ipc/contract'
import { formatDay } from '../../lib/dates'
import { countOf } from '../../lib/format'
import { FaceThumb } from './DayCell'
import { FORTNIGHT_DAYS, MONTH_NAMES, WEEK_DAYS, yearDays, yearWeeks, type DayRange, type WeekCell } from './daysModel'
import { useOnScreen } from './useOnScreen'

/** Any width asks for the smallest thumbnail bucket: a week's face is about 14–22 px. */
const WEEK_THUMB_CSS_PX = 1
/** Week columns line up across years; a common year places the month labels. */
const LABEL_YEAR = 2001
/** Below this column width (CSS px) a week's face is a speck: the strip shows two weeks per face instead. */
const MIN_WEEK_PX = 16
const WEEKS_PER_YEAR = 53

/**
 * Days per column: a week while the strip gives each week at least
 * MIN_WEEK_PX, else two (about 22 px faces at 1440 px with the inspector,
 * instead of 14 px). Unknown width (no layout yet) counts as wide.
 */
function useSpanDays(strip: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('.decade-months')
    if (!el) return
    // The observer also reports the first size, as soon as it observes.
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [strip])
  return width > 0 && width / WEEKS_PER_YEAR < MIN_WEEK_PX ? FORTNIGHT_DAYS : WEEK_DAYS
}

interface WeekProps {
  week: WeekCell
  span: number
  photo: PhotoSummary | undefined
  base: string
}

/** One week: its face, an empty frame when no day of it has a photo, nothing outside the library. */
function Week({ week, span, photo, base }: WeekProps) {
  const state = !week.inRange ? 'out' : week.face === null ? 'empty' : week.excluded ? 'excluded' : null
  return (
    <span
      className={state ? `wk ${state}` : 'wk'}
      data-week={week.index}
      data-day={week.face ?? undefined}
      data-month-start={week.monthStart ? '' : undefined}
      title={week.face ? `${span === WEEK_DAYS ? 'Week' : 'Two weeks'} from ${formatDay(week.start)}` : undefined}
    >
      {photo ? <FaceThumb photo={photo} base={base} cellPx={WEEK_THUMB_CSS_PX} /> : null}
    </span>
  )
}

interface YearRowProps {
  year: number
  byDay: ReadonlyMap<DayKey, DayGroup>
  photos: ReadonlyMap<string, PhotoSummary>
  base: string
  range: DayRange
  current: boolean
  /** Days per column (a week, or two on a narrow strip). */
  span: number
  /** False while the row is far off screen: its weeks keep their frames, not their images. */
  faces: boolean
  onPickYear: (year: number) => void
  onPickDay: (day: DayKey) => void
}

/**
 * A year as a strip of weekly faces. The year label is the row's button (and
 * its keyboard path); the faces are a pointer shortcut to Year zoom at that
 * week, hidden from assistive tech so ten years aren't 530 buttons.
 */
const YearRow = memo(function YearRow({ year, byDay, photos, base, range, current, span, faces, onPickYear, onPickDay }: YearRowProps) {
  const weeks = useMemo(() => yearWeeks(year, byDay, range, span), [year, byDay, range, span])
  const count = useMemo(() => yearDays(year).filter((k) => byDay.has(k)).length, [year, byDay])
  const pick = (e: MouseEvent<HTMLElement>) => {
    const day = (e.target as Element).closest('[data-day]')?.getAttribute('data-day')
    if (day) onPickDay(day)
  }
  return (
    <div className="decade-row" data-year={year}>
      <button type="button" className="decade-year label-caps" aria-current={current} aria-label={`${year}, ${countOf(count, 'day')} with a photo`} onClick={() => onPickYear(year)}>
        {year}
      </button>
      <div className="decade-weeks" aria-hidden="true" onClick={pick}>
        {weeks.map((w) => {
          const group = faces && w.face ? byDay.get(w.face) : undefined
          return <Week key={w.index} week={w} span={span} photo={group ? photos.get(group.selectedId) : undefined} base={base} />
        })}
      </div>
    </div>
  )
})

/** Three-letter month names over the columns where each month begins. */
function MonthLabels({ span }: { span: number }) {
  const starts = useMemo(() => yearWeeks(LABEL_YEAR, new Map(), { first: null, last: null }, span).filter((w) => w.index === 0 || w.monthStart), [span])
  return (
    <div className="decade-head" aria-hidden="true">
      <span />
      <div className="decade-months">
        {starts.map((w, i) => {
          const next = starts[i + 1]
          return (
            <span key={w.index} style={{ gridColumn: `${w.index + 1} / ${next ? next.index + 1 : -1}` }}>
              {MONTH_NAMES[i]?.slice(0, 3)}
            </span>
          )
        })}
      </div>
    </div>
  )
}

interface DecadeViewProps {
  years: number[]
  byDay: ReadonlyMap<DayKey, DayGroup>
  photos: ReadonlyMap<string, PhotoSummary>
  base: string
  range: DayRange
  currentYear: number
  onPickYear: (year: number) => void
  onPickDay: (day: DayKey) => void
}

/**
 * Decade zoom (P2-10): one row of weekly faces per year, month hairlines
 * running down through the decade. Rows more than a screen away drop their
 * images, like the Year zoom's months.
 */
export function DecadeView({ years, currentYear, ...p }: DecadeViewProps) {
  const ref = useRef<HTMLDivElement>(null)
  const span = useSpanDays(ref)
  const { near } = useOnScreen(ref, '.decade-row', 'data-year', years.join(','))
  const columns = Math.ceil(366 / span)
  return (
    <div ref={ref} className="decade-view" style={{ '--wk-cols': columns } as CSSProperties}>
      <MonthLabels span={span} />
      {years.map((y) => (
        <YearRow key={y} year={y} current={y === currentYear} span={span} faces={near === null || near.has(y)} {...p} />
      ))}
    </div>
  )
}
