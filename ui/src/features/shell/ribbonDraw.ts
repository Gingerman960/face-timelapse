// Canvas drawing for the decade ribbon. Two canvases, redrawn only when the
// days, the size or the theme change (never per frame or per seek: the cursor
// and the span rule are DOM overlays on top).
import type { DayKey } from '../../ipc/contract'
import { dayRuns, monthMarks } from './ribbonModel'

export const FOCUS_H = 34
export const DECADE_H = 18

/**
 * Focus-row layout, CSS px from the top (critique round 4, P1-6). Month ticks
 * stand on the baseline with their letter beside them; decisions hang under
 * it, the way "your pick" underlines a day cell.
 */
const BASELINE_Y = 22
const MONTH_TICK_H = 8
const DECISION_Y = 25
const DECISION_H = 6
/** A pick's dash fills this share of its day, within these widths, so neighbouring picks stay separate dashes. */
const PICK_SHARE = 0.66
const PICK_MIN_W = 1.5
const PICK_MAX_W = 3
/** DESIGN's left-out hatch: 1 px lines every 4 px at 135°, text-2 at 60 %. */
const HATCH_PITCH = 4
const HATCH_ALPHA = 0.6
const HATCH_MIN_W = 2
const UNEXPOSED_ALPHA = 0.5
const UNEXPOSED_DECADE_ALPHA = 0.18
const COVERAGE_FLOOR = 0.4

interface Colors {
  /** Days with a photo: the baseline, in a quiet zone, so the photos stay the only light. */
  day: string
  /** Month ticks. */
  month: string
  /** The bracket on the decade row: ink. */
  strong: string
  off: string
  mark: string
  hatch: string
  /** Decade coverage. */
  fill: string
}

function readColors(el: Element): Colors {
  const cs = getComputedStyle(el)
  const v = (name: string) => cs.getPropertyValue(name).trim() || '#888'
  return {
    day: v('--ribbon-day'),
    month: v('--ribbon-month'),
    strong: v('--text-1'),
    off: v('--line'),
    mark: v('--mark'),
    hatch: v('--text-2'),
    fill: v('--ribbon-fill'),
  }
}

/** Sizes the backing store for the device pixel ratio and clears it; null where there is no 2D context (jsdom). */
export function setupCanvas(canvas: HTMLCanvasElement, height: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const pw = Math.max(1, Math.round(w * dpr))
  const ph = Math.round(height * dpr)
  // Setting a canvas's size reallocates its backing store even when unchanged (N3): only on a real resize.
  if (canvas.width !== pw) canvas.width = pw
  if (canvas.height !== ph) canvas.height = ph
  const ctx = canvas.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx?.clearRect(0, 0, w, height)
  return ctx
}

/** Half-pixel snapping: crisp 1 px lines at 2×. */
function snap(x: number): number {
  return Math.round(x * 2) / 2
}

/** Which days a running job has exposed so far. */
interface Exposure {
  /** A job that runs in date order (aligning): every day up to this one. */
  exposedUntil?: DayKey | null
  /**
   * A job that runs in no order of date (scanning): exactly these days, wherever
   * they fall (critique round 5, P2-9). Takes precedence over `exposedUntil`.
   */
  exposedDays?: ReadonlySet<DayKey> | null
}

/** The exposure test for one draw, or null when every day is exposed (no job running). */
function exposureTest({ exposedUntil, exposedDays }: Exposure): ((key: DayKey) => boolean) | null {
  if (exposedDays) return (key) => exposedDays.has(key)
  if (exposedUntil) return (key) => key <= exposedUntil
  return null
}

export interface FocusDraw extends Exposure {
  year: number
  keys: readonly DayKey[]
  present: ReadonlySet<DayKey>
  mine?: ReadonlySet<DayKey>
  excluded?: ReadonlySet<DayKey>
}

/** 135° hatch (lines rising to the right) over the left-out runs, clipped to them; one stroke for all. */
function drawHatch(ctx: CanvasRenderingContext2D, runs: ReadonlyArray<readonly [number, number]>, step: number, color: string): void {
  if (runs.length === 0) return
  ctx.save()
  ctx.beginPath()
  for (const [a, b] of runs) ctx.rect(snap(a * step), DECISION_Y, Math.max(HATCH_MIN_W, snap(b * step) - snap(a * step)), DECISION_H)
  ctx.clip()
  ctx.beginPath()
  for (const [a, b] of runs) {
    for (let x = snap(a * step) - DECISION_H; x < b * step + HATCH_PITCH; x += HATCH_PITCH) {
      ctx.moveTo(x, DECISION_Y + DECISION_H)
      ctx.lineTo(x + DECISION_H, DECISION_Y)
    }
  }
  ctx.globalAlpha = HATCH_ALPHA
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.restore()
  ctx.globalAlpha = 1
}

/** One 1 px stretch of the baseline row per run of days, `[a, b)`. */
function fillRuns(ctx: CanvasRenderingContext2D, runs: ReadonlyArray<readonly [number, number]>, step: number): void {
  for (const [a, b] of runs) {
    const x0 = snap(a * step)
    ctx.fillRect(x0, BASELINE_Y, Math.max(1, snap(b * step) - x0), 1)
  }
}

/**
 * The focus year (critique round 4, P1-6): a 1 px baseline under the days
 * that have a photo, broken where a day has none; an 8 px tick on each
 * month's first day; a chinagraph dash under each day whose photo you chose
 * by hand; the hatch under days left out (never a dash: that pick isn't in
 * the timelapse). While a job runs, days it hasn't exposed yet show a faint
 * line: the tail of the year for one that runs in date order, every day not
 * found yet for a scan.
 */
export function drawFocusYear(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, d: FocusDraw): void {
  const c = readColors(canvas)
  const width = canvas.clientWidth
  const step = width / Math.max(1, d.keys.length)
  const exposed = exposureTest(d) ?? (() => true)

  ctx.fillStyle = c.month
  for (const m of monthMarks(d.year)) ctx.fillRect(snap(m.offset * step), BASELINE_Y - MONTH_TICK_H, 1, MONTH_TICK_H)

  ctx.fillStyle = c.day
  fillRuns(ctx, dayRuns(d.keys, (k) => exposed(k) && d.present.has(k)), step)
  ctx.globalAlpha = UNEXPOSED_ALPHA
  ctx.fillStyle = c.off
  fillRuns(ctx, dayRuns(d.keys, (k) => !exposed(k)), step)
  ctx.globalAlpha = 1

  const { excluded, mine } = d
  if (excluded && excluded.size > 0) drawHatch(ctx, dayRuns(d.keys, (k) => exposed(k) && excluded.has(k)), step, c.hatch)
  if (mine && mine.size > 0) {
    const w = Math.min(PICK_MAX_W, Math.max(PICK_MIN_W, step * PICK_SHARE))
    ctx.fillStyle = c.mark
    d.keys.forEach((key, i) => {
      if (exposed(key) && mine.has(key) && !excluded?.has(key) && d.present.has(key)) ctx.fillRect(snap(i * step + (step - w) / 2), DECISION_Y, w, DECISION_H)
    })
  }
}

export interface DecadeDraw extends Exposure {
  keys: readonly DayKey[]
  present: ReadonlySet<DayKey>
  /** The focus year's first day and length, in days from the decade's start. */
  focusOffset: number
  focusDays: number
}

/**
 * The decade: one column per pixel, darker where more days have a photo, with
 * the focus year boxed. A column none of whose days a running job has exposed
 * yet stays faint.
 */
export function drawDecade(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, d: DecadeDraw): void {
  const c = readColors(canvas)
  const w = canvas.clientWidth
  const per = d.keys.length / Math.max(1, w)
  const exposed = exposureTest(d)
  for (let x = 0; x < w; x++) {
    let hit = 0
    let tot = 0
    let seen = 0
    const i0 = Math.floor(x * per)
    const i1 = Math.max(i0 + 1, Math.floor((x + 1) * per))
    for (let i = i0; i < i1; i++) {
      tot++
      const key = d.keys[i]
      if (!key || (exposed && !exposed(key))) continue
      seen++
      if (d.present.has(key)) hit++
    }
    const unexposed = exposed !== null && seen === 0
    // Coverage stays dark (Z4) / quiet (Z7 in light): the photos are the only light; ink is for the bracket and playhead.
    ctx.globalAlpha = unexposed ? UNEXPOSED_DECADE_ALPHA : COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * (tot ? hit / tot : 0)
    ctx.fillStyle = unexposed ? c.off : c.fill
    ctx.fillRect(x, 4, 1, DECADE_H - 8)
  }
  ctx.globalAlpha = 1
  const fx0 = d.focusOffset / per
  const fx1 = fx0 + d.focusDays / per
  ctx.strokeStyle = c.strong
  ctx.lineWidth = 1
  ctx.strokeRect(Math.max(0.5, fx0) + 0.5, 0.5, Math.min(w - 1, fx1) - Math.max(0.5, fx0), DECADE_H - 1)
}
