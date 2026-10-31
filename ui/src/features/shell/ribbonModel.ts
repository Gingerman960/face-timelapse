// Pure geometry of the decade ribbon's focus row (critique round 4, P1-6):
// month ticks, runs of days, the visible-span rule and the loupe's place.
import type { DayKey } from '../../ipc/contract'
import { daysBetween, daysInMonth, daysInYear, makeDayKey } from '../../lib/dates'

const MONTH_LETTERS = 'JFMAMJJASOND'
const MONTHS_PER_YEAR = 12

/** A month's tick on the focus year: its first day, as a day offset and a share of the year. */
export interface MonthMark {
  /** 1-based month. */
  month: number
  /** J F M … D, printed beside the tick in edge print. */
  letter: string
  /** Days from 1 January to the month's first day. */
  offset: number
  /** `offset` as a share of the year, 0..1. */
  fraction: number
}

/** The twelve month ticks of `year`, January first. */
export function monthMarks(year: number): MonthMark[] {
  const total = daysInYear(year)
  let offset = 0
  return Array.from({ length: MONTHS_PER_YEAR }, (_, i) => {
    const mark = { month: i + 1, letter: MONTH_LETTERS[i] ?? '', offset, fraction: offset / total }
    offset += daysInMonth(year, i + 1)
    return mark
  })
}

/** A run of consecutive days, as `[start, end)` indexes into the day list. */
export type DayRun = readonly [start: number, end: number]

/** Consecutive days that pass `test`, as runs: one draw call per run instead of one per day. */
export function dayRuns(keys: readonly DayKey[], test: (key: DayKey) => boolean): DayRun[] {
  const runs: DayRun[] = []
  let start = -1
  keys.forEach((key, i) => {
    const hit = test(key)
    if (hit && start < 0) start = i
    if (!hit && start >= 0) {
      runs.push([start, i])
      start = -1
    }
  })
  if (start >= 0) runs.push([start, keys.length])
  return runs
}

/** Where a span sits on the focus year, as shares of the year. */
export interface SpanBox {
  left: number
  width: number
}

/**
 * The visible-span rule under the focus row, clipped to `year`; null when
 * there is no span, when it misses the year, or when it covers all of it
 * (a rule under every day says nothing: Year zoom showing the whole year).
 */
export function spanBox(span: { start: DayKey; end: DayKey } | null | undefined, year: number): SpanBox | null {
  if (!span) return null
  const first = makeDayKey(year, 1, 1)
  const total = daysInYear(year)
  const from = Math.max(0, daysBetween(first, span.start))
  const to = Math.min(total, daysBetween(first, span.end) + 1)
  if (to <= from || (from === 0 && to === total)) return null
  return { left: from / total, width: (to - from) / total }
}

/** The loupe's centre on a track `width` wide: under the pointer, clamped so all of it stays over the track. */
export function loupeCentre(x: number, width: number, half: number): number {
  if (width <= 2 * half) return width / 2
  return Math.min(width - half, Math.max(half, x))
}
