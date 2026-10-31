import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { DayKey } from '../../ipc/contract'
import { addDays, dayRange, daysBetween, daysInYear, formatDayLong, formatDayShort, makeDayKey } from '../../lib/dates'
import { useThemeVersion } from './useTheme'
import { RetryImg } from '../../components/ui/RetryImg'
import { DECADE_H, FOCUS_H, drawDecade, drawFocusYear, setupCanvas } from './ribbonDraw'
import { loupeCentre, monthMarks, spanBox } from './ribbonModel'
import './ribbon.css'

/** Keyboard jumps on the hidden slider: PageUp/PageDown ≈ a month, ⌥←/⌥→ a year. */
const MONTH_JUMP_DAYS = 30
const YEAR_JUMP_DAYS = 365
/** Half the loupe's width: a 160 px face (DESIGN) in 4 px of padding. */
const LOUPE_HALF_PX = 84

export interface RibbonProps {
  /** First and last day of the decade shown. */
  start: DayKey
  end: DayKey
  /** Days that have a photo: the focus row's baseline, broken on the days without one. */
  present: ReadonlySet<DayKey>
  /** Days whose photo you chose by hand: a chinagraph dash under the day (chinagraph = your decision). */
  mine?: ReadonlySet<DayKey>
  /** Days left out of the timelapse: hatched under the day, never a dash (that pick isn't in the timelapse). */
  excluded?: ReadonlySet<DayKey>
  focusYear: number
  /** Playhead or selected day (neutral ink). */
  cursor?: DayKey | null
  /** While a job runs in date order (aligning): days after this are not exposed yet. */
  exposedUntil?: DayKey | null
  /**
   * While a job runs in no order of date (scanning): only these days are exposed so
   * far, each in its year as it's read; every other day stays faint. Takes
   * precedence over `exposedUntil` (critique round 5, P2-9).
   */
  exposedDays?: ReadonlySet<DayKey> | null
  onSeek?: (day: DayKey) => void
  /** Optional loupe image for a hovered day (shown at 160 px: ask for a 160 px thumbnail). */
  loupeUrl?: (day: DayKey) => string | null
  /**
   * Days the calendar or sheet shows right now (the months in view in Year
   * zoom, the month in Month zoom, the library rows on screen). Marked under
   * the focus row by two crop-mark feet at its ends, clipped to the focus
   * year; null, or a span that covers the whole year, draws nothing. Drawn
   * as an overlay, so scrolling never redraws the canvases.
   */
  visibleSpan?: { start: DayKey; end: DayKey } | null
  label: string
}

/**
 * Bumps when "Increase contrast" turns on or off. The canvases read the
 * ribbon tokens when they draw, and those step up under `prefers-contrast:
 * more` (critique round 5, P3-27), so a change has to redraw them.
 */
function useContrastVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-contrast: more)')
    if (!mq) return
    const bump = () => setVersion((v) => v + 1)
    mq.addEventListener('change', bump)
    return () => mq.removeEventListener('change', bump)
  }, [])
  return version
}

/** The shared time map: the focus year, day by day with its months, over a binned decade overview. */
export function DecadeRibbon(props: RibbonProps) {
  const { start, end, present, mine, excluded, focusYear, cursor, exposedUntil, exposedDays, onSeek, loupeUrl, label, visibleSpan } = props
  const focusRef = useRef<HTMLCanvasElement>(null)
  const decadeRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<{ day: DayKey; x: number } | null>(null)
  const themeVersion = useThemeVersion()
  const contrastVersion = useContrastVersion()
  const span = Math.max(1, daysBetween(start, end) + 1)
  const yearFirst = makeDayKey(focusYear, 1, 1)
  const yearDays = daysInYear(focusYear)
  const yearOffset = daysBetween(start, yearFirst)
  const decadeKeys = useMemo(() => dayRange(start, span), [start, span])
  const focusKeys = useMemo(() => dayRange(yearFirst, yearDays), [yearFirst, yearDays])

  useEffect(() => {
    const el = decadeRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // HIGH-3: give the canvases' backing stores back when the ribbon goes away.
  useEffect(() => {
    const canvases = [focusRef.current, decadeRef.current]
    return () => {
      for (const c of canvases) {
        if (c) {
          c.width = 0
          c.height = 0
        }
      }
    }
  }, [])

  useEffect(() => {
    const canvas = focusRef.current
    const ctx = canvas ? setupCanvas(canvas, FOCUS_H) : null
    if (canvas && ctx) drawFocusYear(canvas, ctx, { year: focusYear, keys: focusKeys, present, mine, excluded, exposedUntil, exposedDays })
  }, [width, themeVersion, contrastVersion, focusYear, focusKeys, present, mine, excluded, exposedUntil, exposedDays])

  useEffect(() => {
    const canvas = decadeRef.current
    const ctx = canvas ? setupCanvas(canvas, DECADE_H) : null
    if (canvas && ctx) drawDecade(canvas, ctx, { keys: decadeKeys, present, exposedUntil, exposedDays, focusOffset: yearOffset, focusDays: yearDays })
  }, [width, themeVersion, contrastVersion, decadeKeys, present, exposedUntil, exposedDays, yearOffset, yearDays])

  // Every year, the first and last partial ones too, labelled at the centre of its span.
  const years = useMemo(() => {
    const first = Number(start.slice(0, 4))
    const last = Number(addDays(start, span - 1).slice(0, 4))
    const out: Array<{ year: number; left: number }> = []
    for (let y = first; y <= last; y++) {
      const from = Math.max(0, daysBetween(start, makeDayKey(y, 1, 1)))
      const to = Math.min(span, daysBetween(start, makeDayKey(y + 1, 1, 1)))
      out.push({ year: y, left: ((from + to) / 2 / span) * 100 })
    }
    return out
  }, [start, span])

  const visible = useMemo(() => spanBox(visibleSpan, focusYear), [visibleSpan, focusYear])
  const months = useMemo(() => monthMarks(focusYear), [focusYear])

  const cursorIndex = cursor ? daysBetween(start, cursor) : null
  const focusCursor = cursor ? daysBetween(yearFirst, cursor) / yearDays : null

  const seekFromPointer = useCallback(
    (e: PointerEvent<HTMLElement>, scope: 'focus' | 'decade') => {
      const rect = e.currentTarget.getBoundingClientRect()
      const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      // f = 1 at the right edge: clamp so it lands on the last day, not the day after.
      const index = (days: number) => Math.min(days - 1, Math.floor(f * days))
      const day = scope === 'focus' ? addDays(yearFirst, index(yearDays)) : addDays(start, index(span))
      return { day, x: e.clientX - rect.left }
    },
    [yearFirst, yearDays, start, span],
  )

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (!onSeek || cursorIndex === null) return
    const jumps: Record<string, number> = { PageUp: -MONTH_JUMP_DAYS, PageDown: MONTH_JUMP_DAYS }
    let delta = jumps[e.key] ?? 0
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) delta = e.key === 'ArrowLeft' ? -YEAR_JUMP_DAYS : YEAR_JUMP_DAYS
    if (!delta) return
    e.preventDefault()
    const next = Math.min(span - 1, Math.max(0, cursorIndex + delta))
    onSeek(addDays(start, next))
  }

  const pointerHandlers = (scope: 'focus' | 'decade') =>
    onSeek
      ? {
          onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            onSeek(seekFromPointer(e, scope).day)
          },
          onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
            const hit = seekFromPointer(e, scope)
            if (scope === 'focus') setHover(hit)
            if (e.currentTarget.hasPointerCapture(e.pointerId)) onSeek(hit.day)
          },
          onPointerLeave: () => setHover(null),
        }
      : {}

  const loupe = hover && loupeUrl ? loupeUrl(hover.day) : null
  return (
    <footer className="ribbon" aria-label={label}>
      <div className="ribbon-focus">
        <span className="ribbon-label label-caps">{focusYear}</span>
        <div className="ribbon-track" {...pointerHandlers('focus')}>
          <canvas ref={focusRef} height={FOCUS_H} aria-hidden="true" style={{ height: FOCUS_H }} />
          <span className="ribbon-months" aria-hidden="true">
            {months.map((m) => (
              <span key={m.month} style={{ left: `${m.fraction * 100}%` }}>
                {m.letter}
              </span>
            ))}
          </span>
          {visible ? <span className="ribbon-visible" aria-hidden="true" style={{ left: `${visible.left * 100}%`, width: `${visible.width * 100}%` }} /> : null}
          {focusCursor !== null && focusCursor >= 0 && focusCursor <= 1 ? (
            <span className="ribbon-cursor" style={{ transform: `translateX(${focusCursor * width}px)` }} />
          ) : null}
          {loupe && hover ? (
            <span className="ribbon-loupe" style={{ left: width > 0 ? loupeCentre(hover.x, width, LOUPE_HALF_PX) : hover.x }} aria-hidden="true">
              <RetryImg src={loupe} alt="" />
              <span className="ribbon-loupe-date">{formatDayShort(hover.day)}</span>
            </span>
          ) : null}
        </div>
      </div>
      <div className="ribbon-decade">
        <div className="ribbon-track" {...pointerHandlers('decade')}>
          <canvas ref={decadeRef} height={DECADE_H} aria-hidden="true" style={{ height: DECADE_H }} />
          {cursorIndex !== null ? <span className="ribbon-cursor" style={{ transform: `translateX(${(cursorIndex / span) * width}px)` }} /> : null}
          {onSeek ? (
            <>
              <input
                className="ribbon-input"
                type="range"
                min={0}
                max={span - 1}
                value={cursorIndex ?? 0}
                aria-label={label}
                aria-valuetext={cursor ? formatDayLong(cursor) : undefined}
                onChange={(e) => onSeek(addDays(start, Number(e.currentTarget.value)))}
                onKeyDown={onKey}
                onPointerDown={(e) => e.stopPropagation()}
              />
              <span className="ribbon-focus-ring" />
            </>
          ) : null}
        </div>
        <div className="ribbon-years" aria-hidden="true">
          {years.map((y) => (
            <span key={y.year} style={{ left: `${y.left}%` }}>
              {y.year}
            </span>
          ))}
        </div>
      </div>
    </footer>
  )
}
