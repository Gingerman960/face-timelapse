import type { DayGroup, DayKey } from '../../ipc/contract'
import { addDays, daysBetween, formatDay, formatShortDate } from '../../lib/dates'
import { formatCount } from '../../lib/format'

/**
 * A run of days (critique round 6, P1-4): from the anchor, where ⇧-click or
 * ⇧←/⇧→ started it, to the selected day, in date order, both ends included.
 */
export interface DayRun {
  start: DayKey
  end: DayKey
}

/** One `set_day_excluded` call of a run. */
export interface DayExclusion {
  dayKey: DayKey
  excluded: boolean
}

/** What X does to a run: the state it gives the run, and the days that change. */
export interface RunPlan {
  excluded: boolean
  changes: DayExclusion[]
  /** Days of the run that have photos. */
  size: number
}

/** The run from `anchor` to `day`; null without an anchor or when they are the same day. */
export function runOf(anchor: DayKey | null, day: DayKey): DayRun | null {
  if (anchor === null || anchor === day) return null
  return anchor < day ? { start: anchor, end: day } : { start: day, end: anchor }
}

export function inRun(run: DayRun | null, day: DayKey): boolean {
  return run !== null && day >= run.start && day <= run.end
}

/** Calendar days in the run, empty ones included. */
export function runCount(run: DayRun): number {
  return daysBetween(run.start, run.end) + 1
}

/** The run's days that have photos, in date order (an empty day can't be left out). */
function runGroups(run: DayRun, byDay: ReadonlyMap<DayKey, DayGroup>): DayGroup[] {
  return Array.from({ length: runCount(run) }, (_, i) => byDay.get(addDays(run.start, i))).filter((g): g is DayGroup => g !== undefined)
}

/** X on a run: leaves every day out while any is still in, else puts them all back. */
export function runChanges(run: DayRun, byDay: ReadonlyMap<DayKey, DayGroup>): RunPlan {
  const groups = runGroups(run, byDay)
  const excluded = groups.some((g) => !g.excluded)
  return { excluded, changes: groups.filter((g) => g.excluded !== excluded).map((g) => ({ dayKey: g.dayKey, excluded })), size: groups.length }
}

/** "2–5 May 2014", "29 Apr – 2 May 2014", "30 Dec 2013 – 2 Jan 2014". */
export function runLabel(run: DayRun): string {
  const end = formatDay(run.end)
  if (run.start.slice(0, 7) === run.end.slice(0, 7)) return `${Number(run.start.slice(8, 10))}–${end}`
  if (run.start.slice(0, 4) === run.end.slice(0, 4)) return `${formatShortDate(run.start)} – ${end}`
  return `${formatDay(run.start)} – ${end}`
}

function days(n: number): string {
  return n === 1 ? '1 day' : `${formatCount(n)} days`
}

/** The toast after X on a run: what changed, in days. */
export function runMessage(excluded: boolean, n: number): string {
  return excluded ? `Left ${days(n)} out` : `Put ${days(n)} back in`
}

/** The inspector row for X on a run with `n` days of photos. */
export function runActionLabel(excluded: boolean, n: number): string {
  const these = n === 1 ? 'this day' : `these ${days(n)}`
  return excluded ? `Leave ${these} out` : `Put ${these} back in`
}
