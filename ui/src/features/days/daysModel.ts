import type { CSSProperties } from 'react'
import type { DayGroup, DayKey, DaysPatch, PhotoId, PhotoSummary, Rect, Size } from '../../ipc/contract'
import { addDays, dayRange, daysInMonth, daysInYear, formatDay, makeDayKey } from '../../lib/dates'
import { formatCount } from '../../lib/format'

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const MONTHS_PER_YEAR = 12

/** The library's first and last day; a null end is open. */
export interface DayRange {
  first: DayKey | null
  last: DayKey | null
}

/** True when `key` lies inside the library's range. */
export function inRange(key: DayKey, range: DayRange): boolean {
  return !((range.first && key < range.first) || (range.last && key > range.last))
}

/** The 1st of the month `delta` months from `day`'s month. */
export function shiftMonth(day: DayKey, delta: number): DayKey {
  const months = Number(day.slice(0, 4)) * MONTHS_PER_YEAR + Number(day.slice(5, 7)) - 1 + delta
  const month = ((months % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR
  return makeDayKey(Math.floor(months / MONTHS_PER_YEAR), month + 1, 1)
}

/** The same day of the month `delta` months away, on the month's last day when it is shorter (31 Jan + 1 → 28 Feb). */
export function shiftMonthKeepDay(day: DayKey, delta: number): DayKey {
  const first = shiftMonth(day, delta)
  const year = Number(first.slice(0, 4))
  const month = Number(first.slice(5, 7))
  return makeDayKey(year, month, Math.min(Number(day.slice(8, 10)), daysInMonth(year, month)))
}

/** `key`, or the nearer end of the range when it lies outside. */
export function clampDay(key: DayKey, range: DayRange): DayKey {
  if (range.first && key < range.first) return range.first
  if (range.last && key > range.last) return range.last
  return key
}

/** `year` kept within the library's years (unchanged when there are none). */
export function clampYear(year: number, years: readonly number[]): number {
  const lo = years[0]
  const hi = years[years.length - 1]
  if (lo === undefined || hi === undefined) return year
  return Math.min(hi, Math.max(lo, year))
}

/** The year of a day key. */
export function yearOf(day: DayKey): number {
  return Number(day.slice(0, 4))
}

/** Every day of `year`, 1 January first. */
export function yearDays(year: number): DayKey[] {
  return dayRange(makeDayKey(year, 1, 1), daysInYear(year))
}

export interface DayIndex {
  byDay: Map<DayKey, DayGroup>
  years: number[]
  first: DayKey | null
  last: DayKey | null
}

/** Day groups keyed by day, plus the year range they span. */
export function indexDays(days: readonly DayGroup[]): DayIndex {
  const byDay = new Map(days.map((d) => [d.dayKey, d]))
  const first = days[0]?.dayKey ?? null
  const last = days[days.length - 1]?.dayKey ?? null
  const years: number[] = []
  if (first && last) for (let y = Number(first.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) years.push(y)
  return { byDay, years, first, last }
}

export interface YearStats {
  withPhoto: number
  total: number
  alternates: number
  empty: number
  /** Days left out of the timelapse. */
  leftOut: number
}

/**
 * The head's summary (critique round 3): what the timelapse gets first, then
 * the counts that aren't zero: "355 in the timelapse · 4 left out · 6 empty ·
 * 4 with alternates". Left-out days are never counted as in.
 */
export function spanSummary(stats: YearStats): string {
  const parts = [
    `${formatCount(stats.withPhoto - stats.leftOut)} in the timelapse`,
    stats.leftOut > 0 ? `${formatCount(stats.leftOut)} left out` : null,
    stats.empty > 0 ? `${formatCount(stats.empty)} empty` : null,
    stats.alternates > 0 ? `${formatCount(stats.alternates)} with alternates` : null,
  ]
  return parts.filter((p) => p !== null).join(' · ')
}

/** Counts over some days, those inside the range only. */
function spanStats(keys: readonly DayKey[], byDay: ReadonlyMap<DayKey, DayGroup>, range: DayRange): YearStats {
  let withPhoto = 0
  let alternates = 0
  let leftOut = 0
  let total = 0
  for (const key of keys) {
    if (!inRange(key, range)) continue
    total++
    const g = byDay.get(key)
    if (g) {
      withPhoto++
      if (g.photoIds.length > 1) alternates++
      if (g.excluded) leftOut++
    }
  }
  return { withPhoto, total, alternates, empty: total - withPhoto, leftOut }
}

/** Counts for the year header ("364 of 365 days · 4 with alternates · 1 empty"). */
export function yearStats(year: number, byDay: ReadonlyMap<DayKey, DayGroup>, range: DayRange): YearStats {
  return spanStats(yearDays(year), byDay, range)
}

/** The days of a 1-based month. */
export function monthDays(year: number, month: number): DayKey[] {
  return dayRange(makeDayKey(year, month, 1), daysInMonth(year, month))
}

/** Counts for the Month zoom header ("29 of 30 days · 1 with alternates · 1 empty"). */
export function monthStats(year: number, month: number, byDay: ReadonlyMap<DayKey, DayGroup>, range: DayRange): YearStats {
  return spanStats(monthDays(year, month), byDay, range)
}

const ALL_MONTHS = Array.from({ length: MONTHS_PER_YEAR }, (_, i) => i + 1)

export interface YearMonths {
  /** The months to draw (1-based). */
  months: number[]
  /** The library's first day, when months before it were left out. */
  before: DayKey | null
  /** The library's last day, when months after it were left out. */
  after: DayKey | null
}

/**
 * The months of `year` worth a grid (P1-2): the ones before the month of the
 * library's first photo and after the month of its last are left out, so the
 * first and last years don't open on empty grids. A year outside the library
 * keeps all twelve.
 */
export function yearMonths(year: number, range: DayRange): YearMonths {
  const overlaps = (m: number) => {
    const from = makeDayKey(year, m, 1)
    const to = makeDayKey(year, m, daysInMonth(year, m))
    return !(range.first && to < range.first) && !(range.last && from > range.last)
  }
  const months = ALL_MONTHS.filter(overlaps)
  const lo = months[0]
  const hi = months[months.length - 1]
  if (lo === undefined || hi === undefined) return { months: ALL_MONTHS, before: null, after: null }
  return { months, before: lo > 1 ? range.first : null, after: hi < MONTHS_PER_YEAR ? range.last : null }
}

/** Decade zoom: a year in seven-day columns from 1 January (or two-week ones when the row is narrow). */
export const WEEK_DAYS = 7
export const FORTNIGHT_DAYS = 14

export interface WeekCell {
  /** Column, 0-based; 53 weeks per year (the last one 1–2 days long), or 27 two-week spans. */
  index: number
  start: DayKey
  /** Some day of the week lies inside the library. */
  inRange: boolean
  /** The day whose photo stands for the week: the first kept one, else the first left out. */
  face: DayKey | null
  /** Every photo of the week is on a left-out day. */
  excluded: boolean
  /** The week where a new month begins (a hairline before it). */
  monthStart: boolean
}

/** A year as weeks (or `span`-day columns) for the Decade zoom (P2-10). Columns line up across years, so months do too. */
export function yearWeeks(year: number, byDay: ReadonlyMap<DayKey, DayGroup>, range: DayRange, span = WEEK_DAYS): WeekCell[] {
  const keys = yearDays(year)
  const weeks: WeekCell[] = []
  for (let i = 0; i * span < keys.length; i++) {
    const chunk = keys.slice(i * span, (i + 1) * span)
    const start = chunk[0] as DayKey
    const kept = chunk.find((k) => byDay.get(k)?.excluded === false)
    const face = kept ?? chunk.find((k) => byDay.has(k)) ?? null
    const previous = weeks[i - 1]
    weeks.push({
      index: i,
      start,
      inRange: chunk.some((k) => inRange(k, range)),
      face,
      excluded: kept === undefined && face !== null,
      monthStart: previous !== undefined && previous.start.slice(5, 7) !== start.slice(5, 7),
    })
  }
  return weeks
}

/**
 * The calendar cell that takes Tab for a view showing `from`…`to`: the active
 * day when the view shows it, else the view's first day inside the range, so
 * the grid is always reachable from the keyboard.
 */
export function tabStop(activeDay: DayKey | null, from: DayKey, to: DayKey, range: DayRange): DayKey | null {
  if (activeDay && activeDay >= from && activeDay <= to && inRange(activeDay, range)) return activeDay
  const first = range.first && range.first > from ? range.first : from
  const last = range.last && range.last < to ? range.last : to
  return first <= last ? first : null
}

/**
 * A face-centred square crop of the full-photo thumbnail, expressed in
 * percentages of the (square) cell, so no measuring is needed. `k` is how
 * many face-widths the square spans.
 */
export function faceCellStyle(faceBox: Rect | null, size: Size, k = 2.1): CSSProperties {
  const W = size.width
  const H = size.height
  if (!faceBox || W <= 0 || H <= 0) return { width: '100%', height: '100%', objectFit: 'cover' }
  const side = Math.min(Math.min(W, H), Math.max(faceBox.width * W, faceBox.height * H) * k)
  const cx = (faceBox.x + faceBox.width / 2) * W
  const cy = (faceBox.y + faceBox.height * 0.46) * H
  const left = Math.min(W - side, Math.max(0, cx - side / 2))
  const top = Math.min(H - side, Math.max(0, cy - side / 2))
  return {
    position: 'absolute',
    maxWidth: 'none',
    width: `${(W / side) * 100}%`,
    height: `${(H / side) * 100}%`,
    left: `${(-left / side) * 100}%`,
    top: `${(-top / side) * 100}%`,
  }
}

/** The photo summaries of a day, in the day's order (score desc). */
export function dayPhotos(group: DayGroup | undefined, photos: ReadonlyMap<string, PhotoSummary>): PhotoSummary[] {
  if (!group) return []
  return group.photoIds.map((id) => photos.get(id)).filter((p): p is PhotoSummary => p !== undefined)
}

/** The day `step` days from `key`, clamped to the range. */
export function stepDay(key: DayKey, step: number, range: DayRange): DayKey {
  return clampDay(addDays(key, step), range)
}

/**
 * The toast after a move (QA LOW). Moving never picks by itself: the day's
 * pick follows the best likeness unless one was chosen by hand, so a better
 * photo takes over. Say which happened, so the change is never silent.
 */
export function movedMessage(patch: DaysPatch, photoId: PhotoId, to: DayKey): string {
  const base = `Moved to ${formatDay(to)}`
  const day = patch.upserted.find((d) => d.dayKey === to)
  if (!day || day.photoIds.length <= 1) return base
  return day.selectedId === photoId ? `${base} · now the pick` : `${base} · added as an alternate`
}

/** A day cell is never drawn smaller than this while one month fits (DESIGN: 26 px; the target floor is 24). */
export const MIN_DAY_CELL_PX = 26
/** The smallest cell at all, when not even one month fits at 26 px. */
const MIN_DAY_CELL_FLOOR_PX = 12
/** Gap between day cells inside a month (days.css `.week`). */
const DAY_GAP_PX = 2
/** A month block's chrome above its weeks: its head and the weekday initials, with their gaps (days.css). */
export const MONTH_CHROME_PX = 54
/** The most week rows a month block draws (a month that starts late in the week). */
const WEEK_ROWS = 6
/** Month blocks per row: only counts that divide the year, so no row is ragged. */
const MONTHS_PER_ROW = [6, 4, 3, 2, 1] as const

export interface YearGrid {
  columns: number
  cellPx: number
  /** A month block's width when the cells are sized to fit the canvas's height; null when they fill their columns. */
  monthPx: number | null
}

export interface YearSpace {
  /** The grid's width and the gap between month columns. */
  width: number
  gap: number
  /** The height the year has below its head, and the gap between month rows; omit to size by width only. */
  height?: number
  rowGap?: number
  /** Months drawn (a year at the library's edge has fewer than 12) and one-line notes beside them ("No photos after…"). */
  months?: number
  notesPx?: number
  /** The week rows of each month drawn, in order (4 to 6); omitted, every month is taken as six. */
  monthWeeks?: readonly number[]
}

/** The week rows each row of months needs at `columns` per row: the most of its months. */
function rowWeeks(weeks: readonly number[], columns: number): number[] {
  const rows: number[] = []
  for (let i = 0; i < weeks.length; i += columns) rows.push(Math.max(...weeks.slice(i, i + columns)))
  return rows
}

/**
 * Year zoom (critique round 4, P2-9): the month blocks per row and the cell
 * size. A cell is never smaller than 26 px; among the layouts that put the
 * whole year on one table (no scroll), the one with the largest cells wins,
 * its cells shrunk to fit the height if they must (at 1920 px: four columns of
 * 35 px cells rather than six of 26). When no layout fits, the most columns
 * that keep 26 px, and the year scrolls.
 */
export function yearColumns(space: YearSpace): YearGrid {
  const { width, gap, height = Number.POSITIVE_INFINITY, rowGap = gap, months = 12, notesPx = 0 } = space
  const weeks = space.monthWeeks ?? Array.from({ length: months }, () => WEEK_ROWS)
  const byWidth = (c: number) => ((width - (c - 1) * gap) / c - (WEEK_DAYS - 1) * DAY_GAP_PX) / WEEK_DAYS
  // Each row of months is as tall as its longest month (critique round 5, P1-5).
  const byHeight = (c: number) => {
    const rows = rowWeeks(weeks, c)
    const weekRows = rows.reduce((a, b) => a + b, 0)
    return (height - notesPx - (rows.length - 1) * rowGap - rows.length * MONTH_CHROME_PX - (weekRows - rows.length) * DAY_GAP_PX) / weekRows
  }
  let best: YearGrid | null = null
  for (const columns of Number.isFinite(height) ? MONTHS_PER_ROW : []) {
    const wide = byWidth(columns)
    if (wide < MIN_DAY_CELL_PX) continue
    const cellPx = Math.min(wide, byHeight(columns))
    if (cellPx < MIN_DAY_CELL_PX || (best && cellPx <= best.cellPx)) continue
    best = { columns, cellPx, monthPx: cellPx < wide ? WEEK_DAYS * cellPx + (WEEK_DAYS - 1) * DAY_GAP_PX : null }
  }
  if (best) return best
  const columns = MONTHS_PER_ROW.find((c) => byWidth(c) >= MIN_DAY_CELL_PX) ?? 1
  return { columns, cellPx: Math.max(MIN_DAY_CELL_FLOOR_PX, byWidth(columns)), monthPx: null }
}
