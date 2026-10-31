import { useMemo, useState, type CSSProperties } from 'react'
import type { DayGroup, DayKey, PhotoSummary } from '../../ipc/contract'
import { formatDayShort, formatMonthYear } from '../../lib/dates'
import type { DaysZoom } from '../../state/view'
import { MonthView, YearView, type ViewProps, type VisibleSpan } from './CalendarViews'
import { DataText } from '../../components/ui/DataText'
import { Notice } from '../../components/ui/Overlays'
import { FaceThumb } from './DayCell'
import { DecadeView } from './DecadeView'
import { monthStats, spanSummary, yearOf, yearStats, type DayIndex, type DayRange } from './daysModel'
import type { MoveDraft } from './useMoveMode'

function Legend() {
  return (
    <ul className="legend" aria-label="Legend">
      <li><i className="lg-alt" />More photos that day</li>
      <li><i className="lg-mine" />Your pick</li>
      <li><i className="lg-empty" />No photo</li>
      <li><i className="lg-out" />Left out</li>
    </ul>
  )
}

interface CanvasHeadProps {
  zoom: 'year' | 'month'
  year: number
  viewDay: DayKey
  byDay: ReadonlyMap<DayKey, DayGroup>
  range: DayRange
}

/**
 * What is on screen and its counts (P1-3): the year in Year zoom ("2014",
 * "355 in the timelapse · 4 left out · 6 empty"), the month in Month zoom, the
 * move target's while moving. The summary has its own row, so the head keeps
 * its height from year to year (critique round 3).
 */
function CanvasHead({ zoom, year, viewDay, byDay, range }: CanvasHeadProps) {
  const month = Number(viewDay.slice(5, 7))
  const monthly = zoom === 'month'
  const stats = useMemo(() => (monthly ? monthStats(yearOf(viewDay), month, byDay, range) : yearStats(year, byDay, range)), [monthly, viewDay, month, year, byDay, range])
  return (
    <header className="year-head">
      <h2 className="year-num">{monthly ? formatMonthYear(viewDay) : year}</h2>
      <DataText as="p" className="meta year-sum">{spanSummary(stats)}</DataText>
      <Legend />
    </header>
  )
}

function MoveBanner({ move }: { move: MoveDraft }) {
  return (
    <p className="move-banner" role="status">
      Moving the photo from {formatDayShort(move.from)} to <strong>{formatDayShort(move.target)}</strong>. Arrows choose the day, <kbd>↩</kbd> moves it,{' '}
      <kbd>Esc</kbd> cancels.
    </p>
  )
}

interface DaysCanvasProps {
  zoom: DaysZoom
  /** The year on screen (the month's year in month zoom, the target's while moving a photo). */
  year: number
  /** The day the view is about: the selected day, or the move target while moving a photo. */
  viewDay: DayKey
  index: DayIndex
  move: MoveDraft | null
  view: ViewProps
  onPickYear: (year: number) => void
  /** Decade zoom: a week's face opens Year zoom on that day. */
  onPickDay: (day: DayKey) => void
  /** Year zoom: the months scrolled into view, for the ribbon. */
  onSpan: (span: VisibleSpan | null) => void
  /** Why the last align failed, said above the calendar until the next one (critique round 4, P2-20). */
  alignError?: string | null
}

/**
 * The calendar: header, the Decade, Year or Month view, and the move-mode
 * banner. The banner floats over the bottom of the canvas (sticky, last in
 * flow), so starting a move never shifts the calendar (critique round 2).
 */
export function DaysCanvas({ zoom, year, viewDay, index, move, view, onPickYear, onPickDay, onSpan, alignError }: DaysCanvasProps) {
  // Year zoom with cells sized to the height: the year lies centred as one sheet and its head is as wide (critique round 5, P1-5).
  const [sheetPx, setSheetPx] = useState<number | null>(null)
  const sheet = zoom === 'year' && sheetPx !== null
  return (
    <div className="days-canvas" data-sheet={sheet ? 'true' : undefined} style={sheet ? ({ '--sheet-w': `${sheetPx}px` } as CSSProperties) : undefined}>
      {alignError ? (
        <div className="days-notice">
          <Notice tone="stop" title="Aligning stopped.">
            {alignError} The frames aligned so far are kept; aligning again does the rest.
          </Notice>
        </div>
      ) : null}
      {zoom !== 'decade' ? <CanvasHead zoom={zoom} year={year} viewDay={viewDay} byDay={index.byDay} range={view.range} /> : null}
      {zoom === 'decade' ? (
        <DecadeView years={index.years} byDay={index.byDay} photos={view.photos} base={view.base} range={view.range} currentYear={year} onPickYear={onPickYear} onPickDay={onPickDay} />
      ) : zoom === 'year' ? (
        <YearView year={year} focusDay={viewDay} onSpan={onSpan} onSheet={setSheetPx} {...view} />
      ) : (
        <MonthView year={yearOf(viewDay)} month={Number(viewDay.slice(5, 7))} {...view} />
      )}
      {move ? <MoveBanner move={move} /> : null}
    </div>
  )
}

interface DragGhostProps {
  photo: PhotoSummary | undefined
  base: string
  from: DayKey | null
  overDay: DayKey | null
}

/** The face that follows the pointer while dragging, with where it would land. */
export function DragGhost({ photo, base, from, overDay }: DragGhostProps) {
  if (!photo) return null
  return (
    <div className="drag-ghost">
      <FaceThumb photo={photo} base={base} cellPx={64} />
      <span className="label-caps">{overDay && overDay !== from ? `Move to ${formatDayShort(overDay)}` : 'Drop on a day'}</span>
    </div>
  )
}
