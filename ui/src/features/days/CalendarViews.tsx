import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { DayGroup, DayKey, FrameSummary, PhotoSummary } from '../../ipc/contract'
import { daysInMonth, formatDay, makeDayKey, monthGrid } from '../../lib/dates'
import { BlankCell, DayCell } from './DayCell'
import { inRun, type DayRun } from './dayRun'
import { inRange, MONTH_NAMES, tabStop, WEEKDAY_INITIALS, yearColumns, yearMonths, yearOf, type DayRange, type YearGrid } from './daysModel'
import { useOnScreen } from './useOnScreen'
import { useJustDecided } from './justDecided'

export interface ViewProps {
  byDay: ReadonlyMap<DayKey, DayGroup>
  photos: ReadonlyMap<string, PhotoSummary>
  base: string
  activeDay: DayKey | null
  /** The selected day's aligned frame, once aligned (the print a screen change carries into the player). */
  activeFrame?: FrameSummary
  /** The run of days selected with the active day (critique round 6, P1-4), or null. */
  run?: DayRun | null
  dragSource: DayKey | null
  /** Highlighted drop target (keyboard move mode or pointer drag). */
  moveTarget: DayKey | null
  range: DayRange
  /** `extend`: ⇧-click or ⇧Space draws the run of days to this day. */
  onSelect: (day: DayKey, extend?: boolean) => void
}

/** Days the calendar has on screen (the ribbon marks them). */
export interface VisibleSpan {
  start: DayKey
  end: DayKey
}

/** Smallest rendered cell, CSS px (also the first guess before measuring). */
const MIN_CELL_PX = 16
const INITIAL_CELL_PX = 30
const DAYS_PER_WEEK = 7
/** A one-line note beside the months ("No photos after 31 Aug 2022") with its row gap, CSS px. */
const NOTE_LINE_PX = 36

function useCellPx<T extends HTMLElement>(columns: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [px, setPx] = useState(INITIAL_CELL_PX)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setPx(Math.max(MIN_CELL_PX, el.clientWidth / columns / DAYS_PER_WEEK))
    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    return () => ro.disconnect()
  }, [columns])
  return [ref, px]
}

/**
 * Year zoom: month blocks per row and the cell size, from the grid's own width
 * and the height the canvas has below the year's head (critique round 4, P2-9).
 */
function useYearGrid<T extends HTMLElement>(monthWeeks: readonly number[], notes: number): [RefObject<T | null>, YearGrid & { sheetPx: number | null }] {
  const ref = useRef<T>(null)
  const [grid, setGrid] = useState<YearGrid & { sheetPx: number | null }>({ columns: 4, cellPx: INITIAL_CELL_PX, monthPx: null, sheetPx: null })
  const weeksKey = monthWeeks.join(',')
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const style = getComputedStyle(el)
      const canvas = el.offsetParent instanceof HTMLElement ? el.offsetParent : null
      const below = canvas ? canvas.clientHeight - el.offsetTop - (Number.parseFloat(getComputedStyle(canvas).paddingBottom) || 0) : Number.POSITIVE_INFINITY
      const gap = Number.parseFloat(style.columnGap) || 0
      const fit = yearColumns({
        width: el.clientWidth,
        gap,
        height: below > 0 ? below : Number.POSITIVE_INFINITY,
        rowGap: Number.parseFloat(style.rowGap) || 0,
        monthWeeks: weeksKey.split(',').map(Number),
        notesPx: notes * NOTE_LINE_PX,
      })
      // Cells sized to the height leave spare width: the year lies centred as one sheet, its head as wide (P1-5).
      const next = { ...fit, sheetPx: fit.monthPx === null ? null : Math.round(fit.columns * fit.monthPx + (fit.columns - 1) * gap) }
      setGrid((g) => (g.columns === next.columns && Math.abs(g.cellPx - next.cellPx) < 0.5 && g.monthPx === next.monthPx && g.sheetPx === next.sheetPx ? g : next))
    }
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.offsetParent instanceof HTMLElement) ro.observe(el.offsetParent)
    update()
    return () => ro.disconnect()
  }, [weeksKey, notes])
  return [ref, grid]
}

interface MonthProps extends ViewProps {
  year: number
  month: number
  cellPx: number
  /** The day that takes Tab in this view (roving tabindex). */
  tabDay: DayKey | null
  /** Month zoom: day numbers, and each day's alternates fanned out behind its face. */
  large?: boolean
  /** False while the month is far off screen: its cells keep their state but drop their images (HIGH-3). */
  faces?: boolean
}

/** One month: a labelled `grid` of week rows; every day cell is its photo. */
function Month({ year, month, cellPx, tabDay, large, faces = true, ...p }: MonthProps) {
  const justDay = useJustDecided((s) => s.day)
  const weeks = monthGrid(year, month)
  const withPhoto = weeks.flat().filter((d) => d !== null && p.byDay.has(d)).length
  const name = `${MONTH_NAMES[month - 1]} ${year}`
  return (
    <section className="month" aria-label={name} data-month={month}>
      <header className="month-head">
        <span className="label-caps">{MONTH_NAMES[month - 1]}</span>
        <span className="mono-meta">
          {withPhoto}/{daysInMonth(year, month)}
        </span>
      </header>
      <div className="wd" aria-hidden="true">
        {WEEKDAY_INITIALS.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="month-days" role="grid" aria-label={name} aria-multiselectable="true">
        {weeks.map((week, w) => (
          <div key={w} className="week" role="row">
            {week.map((key, i) => {
              if (key === null) return <BlankCell key={`blank-${i}`} />
              const group = p.byDay.get(key)
              return (
                <DayCell
                  key={key}
                  dayKey={key}
                  group={group}
                  photo={group && faces ? p.photos.get(group.selectedId) : undefined}
                  base={p.base}
                  cellPx={cellPx}
                  selected={key === p.activeDay}
                  inRun={inRun(p.run ?? null, key)}
                  frame={key === p.activeDay ? p.activeFrame : undefined}
                  just={key === justDay}
                  focusable={key === tabDay}
                  inRange={inRange(key, p.range)}
                  source={key === p.dragSource}
                  target={key === p.moveTarget}
                  showNumber={large}
                  fanFrom={large ? p.photos : undefined}
                  onSelect={p.onSelect}
                />
              )
            })}
          </div>
        ))}
      </div>
    </section>
  )
}

interface YearViewProps extends ViewProps {
  year: number
  /** The day to keep in view: the selected day, or the move target while moving a photo. */
  focusDay: DayKey
  /** Reports the months scrolled into view, as days (null before any is known). */
  onSpan?: (span: VisibleSpan | null) => void
  /** Reports the year's width when it lies centred as one sheet (cells sized to the height), else null. */
  onSheet?: (px: number | null) => void
}

/**
 * Brings the month of `focusDay` into view when it is in `year`: on landing,
 * and whenever that month changes (ribbon, find a date, move target).
 */
function useMonthInView(grid: RefObject<HTMLElement | null>, year: number, focusDay: DayKey): void {
  const month = yearOf(focusDay) === year ? Number(focusDay.slice(5, 7)) : null
  useEffect(() => {
    if (month !== null) grid.current?.querySelector(`[data-month="${month}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [grid, year, month])
}

/** The days of the visible months, from the first to the last one. */
function spanOf(year: number, months: ReadonlySet<number>): VisibleSpan | null {
  if (months.size === 0) return null
  const lo = Math.min(...months)
  const hi = Math.max(...months)
  return { start: makeDayKey(year, lo, 1), end: makeDayKey(year, hi, daysInMonth(year, hi)) }
}

/** "No photos before 1 Sep 2012": the months outside the library, as one line (P1-2). */
function OutsideLibrary({ children }: { children: string }) {
  return <p className="months-outside">{children}</p>
}

/**
 * The year's month blocks; every day cell is its photo. Months before the
 * library's first photo or after its last collapse into one line, and months
 * more than a screen away keep their cells but not their images.
 */
export function YearView({ year, focusDay, onSpan, onSheet, ...p }: YearViewProps) {
  const { months, before, after } = yearMonths(year, p.range)
  const monthWeeks = months.map((m) => monthGrid(year, m).length)
  const [ref, { columns, cellPx: px, monthPx, sheetPx }] = useYearGrid<HTMLDivElement>(monthWeeks, (before ? 1 : 0) + (after ? 1 : 0))
  useEffect(() => onSheet?.(sheetPx), [onSheet, sheetPx])
  const { near, visible } = useOnScreen(ref, 'section.month', 'data-month', `${year}:${months.join(',')}`)
  const span = useMemo(() => spanOf(year, visible), [year, visible])
  useEffect(() => onSpan?.(span), [onSpan, span])
  useMonthInView(ref, year, focusDay)
  const tabDay = tabStop(p.activeDay, makeDayKey(year, 1, 1), makeDayKey(year, 12, 31), p.range)
  return (
    <div
      ref={ref}
      className="year-grid"
      data-sheet={sheetPx === null ? undefined : 'true'}
      style={{ gridTemplateColumns: monthPx === null ? `repeat(${columns}, minmax(0, 1fr))` : `repeat(${columns}, ${monthPx}px)` }}
    >
      {before ? <OutsideLibrary>{`No photos before ${formatDay(before)}`}</OutsideLibrary> : null}
      {months.map((m) => (
        <Month key={m} year={year} month={m} cellPx={px} tabDay={tabDay} faces={near === null || near.has(m)} {...p} />
      ))}
      {after ? <OutsideLibrary>{`No photos after ${formatDay(after)}`}</OutsideLibrary> : null}
    </div>
  )
}

/** One month at large size: day numbers, and alternates fanned out behind each face. */
export function MonthView({ year, month, ...p }: ViewProps & { year: number; month: number }) {
  const [ref, px] = useCellPx<HTMLDivElement>(1)
  const tabDay = tabStop(p.activeDay, makeDayKey(year, month, 1), makeDayKey(year, month, daysInMonth(year, month)), p.range)
  return (
    <div ref={ref} className="month-view">
      <Month year={year} month={month} cellPx={px} tabDay={tabDay} large {...p} />
    </div>
  )
}

