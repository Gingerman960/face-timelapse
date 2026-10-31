import type { DayKey, FrameSummary } from '../../ipc/contract'
import { formatShortDate } from '../../lib/dates'
import { countOf, formatCount, formatElapsed, formatLength, formatZone } from '../../lib/format'

/** Median of `values`; 0 for none. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

/** Index of the first frame on or after `day` (last frame if none). */
export function frameIndexForDay(frames: ReadonlyArray<Pick<FrameSummary, 'dayKey'>>, day: DayKey): number {
  let lo = 0
  let hi = frames.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((frames[mid]?.dayKey ?? '') < day) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo)
}

/** The frame on or after the same date one year earlier or later (⌥← / ⌥→). */
export function yearJumpIndex(frames: ReadonlyArray<Pick<FrameSummary, 'dayKey'>>, from: DayKey, dir: 1 | -1): number {
  const year = Number(from.slice(0, 4)) + dir
  return frameIndexForDay(frames, `${year}${from.slice(4)}`)
}

/** Days with a frame, plus days that just finished aligning. */
export function presentDays(frames: ReadonlyArray<{ dayKey: DayKey }>, recent: ReadonlyArray<{ dayKey: DayKey }>): Set<DayKey> {
  return new Set([...frames.map((f) => f.dayKey), ...recent.map((r) => r.dayKey)])
}

/** "14 Aug 2014". */
function plateDay(day: DayKey): string {
  return `${formatShortDate(day)} ${day.slice(0, 4)}`
}

/** "3,547 days · 14 Aug 2014 – 30 Aug 2024" ("1 day · …"): each frame is a chosen day (critique round 6, P2-7). */
export function framesSubtitle(count: number, firstDay: DayKey | null, lastDay: DayKey | null): string {
  const span = firstDay && lastDay ? ` · ${plateDay(firstDay)} – ${plateDay(lastDay)}` : ''
  return `${countOf(count, 'day')}${span}`
}

/** The sheet bar: "3,547 days · 11 to check" ("1 day · all within 3× the median fit"). */
export function sheetSummary(count: number, outliers: number): string {
  return `${countOf(count, 'day')} · ${outliers > 0 ? `${formatCount(outliers)} to check` : 'all within 3× the median fit'}`
}

/** What the align announcer says: started, "Aligning. 120 of 3,547 days.", then the finish. */
export function alignMessage(aligning: boolean, done: number, total: number, count: number): string {
  if (!aligning) return `Alignment finished. ${countOf(count, 'day')}.`
  return total > 0 ? `Aligning. ${formatCount(done)} of ${countOf(total, 'day')}.` : 'Aligning started.'
}

/**
 * A video length in the ledger's format, "3:00" for 179.6 s (critique round 4,
 * item 4: the transport read "02:59.6" beside the ledger's "3:00").
 */
export const formatVideoLength = formatLength

/** The playhead's video time in the same format, counting whole seconds reached. */
export const formatVideoTime = formatElapsed

/**
 * The plate's one facts line: "Day 1,439 of 3,573", the chosen day on show
 * (critique round 6, P2-7: "Frame 3 of 3,547 · day 4" counted one thing two ways).
 */
export function framesLine(index: number, count: number): string {
  return `Day ${formatCount(index + 1)} of ${formatCount(count)}`
}

/** How a frame's alignment residual compares with the median of all frames. */
export type FitBand = 'tight' | 'ok' | 'loose'

/** Up to 1.5× the median fit is tight. */
export const FIT_TIGHT = 1.5
/** Over 3× the median is loose: the sheet's outlier rule (DESIGN: safelight corner). */
export const FIT_LOOSE = 3
/** The scale's right end: three equal bands. */
const FIT_SCALE_END = FIT_TIGHT * 3

/** Tight (≤ 1.5× the median), ok (≤ 3×) or loose (> 3×, the sheet's outliers); null without a median. */
export function fitBand(residualPx: number, medianPx: number): FitBand | null {
  if (!(medianPx > 0)) return null
  if (residualPx > FIT_LOOSE * medianPx) return 'loose'
  return residualPx <= FIT_TIGHT * medianPx ? 'tight' : 'ok'
}

/** Where the fit sits on its three-band scale, 0–1 (held at the loose end). */
export function fitScaleAt(residualPx: number, medianPx: number): number {
  if (!(medianPx > 0) || !(residualPx > 0)) return 0
  return Math.min(1, residualPx / medianPx / FIT_SCALE_END)
}

/** The fit in words, before its units (critique round 5, P2-12: "Tightly lined up · 4.6 px"). */
export function fitWords(band: FitBand | null): string {
  if (band === 'tight') return 'Tightly lined up'
  return band === 'loose' ? 'Loosely lined up' : 'Lined up'
}

/** What evening the light did to a face, words first: "Brightened ⅔ stop" (`text`), in its parts for setting. */
export interface ExposureChange {
  words: 'Brightened' | 'Darkened' | 'Already even'
  /** The size in thirds of a stop ("⅔", "1⅓"); null when it rounds to nothing. */
  amount: string | null
  unit: 'stop' | 'stops' | null
  text: string
}

/** The longest change the wedge can show, in stops (formatZone's range). */
const MAX_STOPS = 10

/**
 * "Brightened ⅔ stop", "Darkened 1⅓ stops", "Already even" (critique round 5,
 * P2-12: the plate read "+⅔ EV"). To the nearest third; one stop or less is singular.
 */
export function exposureChange(ev: number): ExposureChange {
  const thirds = Number.isFinite(ev) ? Math.round(Math.abs(ev) * 3) : 0
  if (thirds === 0) return { words: 'Already even', amount: null, unit: null, text: 'Already even' }
  const words = ev > 0 ? 'Brightened' : 'Darkened'
  // formatZone writes a 0–10 value in thirds ("1⅓"), which is what a stop count needs.
  const amount = formatZone(Math.min(MAX_STOPS, thirds / 3))
  const unit = thirds > 3 ? 'stops' : 'stop'
  return { words, amount, unit, text: `${words} ${amount} ${unit}` }
}

/** The zone the face is measured from on the wedge. */
export const WEDGE_FROM_ZONE = 5

/** "From zone 5 to 5⅔": the wedge's label, in thirds, words first (critique round 5, P2-12). */
export function zoneLabel(ev: number): string {
  return `From zone ${formatZone(WEDGE_FROM_ZONE)} to ${formatZone(WEDGE_FROM_ZONE + ev)}`
}

/** "Face exposure moved from zone 5 to 5⅔" (DESIGN, zone wedge). */
export function zoneSpeech(ev: number): string {
  return `Face exposure moved from zone ${formatZone(WEDGE_FROM_ZONE)} to ${formatZone(WEDGE_FROM_ZONE + ev)}`
}

/** Frames a ⇧-arrow moves on a strip, like ⇧←/⇧→ on the player. */
const STRIP_BIG_STEP = 10

/**
 * Where a key moves a strip's one tab stop (roving tabindex, critique round 4
 * item 21): ←/→ one frame (⇧ ten), Home/End to the ends, clamped to
 * [min, max]; null for keys the strip leaves alone.
 */
export function stripKeyTarget(key: string, shift: boolean, active: number, min: number, max: number): number | null {
  const step = shift ? STRIP_BIG_STEP : 1
  const clamp = (i: number) => Math.max(min, Math.min(max, i))
  switch (key) {
    case 'ArrowLeft':
      return clamp(active - step)
    case 'ArrowRight':
      return clamp(active + step)
    case 'Home':
      return min
    case 'End':
      return max
    default:
      return null
  }
}
