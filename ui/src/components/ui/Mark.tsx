import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Chinagraph (grease-pencil) marks. Red marks are editorial decisions about
 * photos; `neutral` marks show "where you are" (current stage, selected day).
 * Strokes stay constant at any size (non-scaling stroke) and extend outside
 * the marked thing, as a pen would.
 *
 * `draw` writes the mark with the pen (critique round 4): the stroke runs from
 * its first point to its last over `--dur-pen`, the way a hand would make it,
 * instead of a left-to-right wipe. Give it only to the mark just made (the
 * photo just kept or left out, the day just picked), never to marks that were
 * already there. Under reduced motion it fades in over 120 ms.
 */
interface MarkProps {
  className?: string
  neutral?: boolean
  draw?: boolean
}

/** The marks' viewBox side: every mark is drawn in a 100 × 100 box and stretched to its element. */
const VIEW = 100
/** Samples along the path when measuring its on-screen length. */
const SAMPLES = 48
/** Slack added to the measured length, so rounding never leaves a dot undrawn. */
const SLACK_PX = 2
const REDUCED_FADE_MS = 120
const PEN_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'
const PEN_FALLBACK_MS = 360

function classes(base: string, { className, neutral }: MarkProps): string {
  return [base, neutral ? 'neutral' : '', className ?? ''].filter(Boolean).join(' ')
}

/** `--dur-pen` in ms (a token, so the theme's motion scale applies). */
function penDuration(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dur-pen').trim()
  const ms = raw.endsWith('ms') ? Number.parseFloat(raw) : raw.endsWith('s') ? Number.parseFloat(raw) * 1000 : Number.NaN
  return Number.isFinite(ms) ? ms : PEN_FALLBACK_MS
}

/**
 * The path's length on screen. Its strokes don't scale (non-scaling stroke),
 * so dashes are measured in screen pixels: sample the path in its 100 × 100
 * box and stretch each step to the element's size.
 */
export function screenLength(path: SVGPathElement): number {
  const box = path.ownerSVGElement?.getBoundingClientRect()
  const sx = (box?.width ?? VIEW) / VIEW
  const sy = (box?.height ?? VIEW) / VIEW
  const total = path.getTotalLength()
  let prev = path.getPointAtLength(0)
  let length = 0
  for (let i = 1; i <= SAMPLES; i++) {
    const point = path.getPointAtLength((total * i) / SAMPLES)
    length += Math.hypot((point.x - prev.x) * sx, (point.y - prev.y) * sy)
    prev = point
  }
  return length + SLACK_PX
}

/** Writes `path` with the pen; returns a cancel. A no-op where SVG geometry or WAAPI is missing (tests). */
export function penStroke(path: SVGPathElement): () => void {
  if (typeof path.getTotalLength !== 'function' || typeof path.animate !== 'function') return () => undefined
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    const fade = path.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REDUCED_FADE_MS, easing: 'linear', fill: 'backwards' })
    return () => fade.cancel()
  }
  const length = screenLength(path)
  path.style.strokeDasharray = `${length} ${length}`
  const pen = path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: penDuration(), easing: PEN_EASE, fill: 'backwards' })
  const done = () => path.style.removeProperty('stroke-dasharray')
  pen.onfinish = done
  return () => {
    pen.cancel()
    done()
  }
}

/** A ref for a mark's path that the pen writes on mount (and again whenever `draw` turns on). */
function usePen(draw: boolean | undefined): RefObject<SVGPathElement | null> {
  const ref = useRef<SVGPathElement>(null)
  useLayoutEffect(() => {
    const path = ref.current
    if (!draw || !path) return
    return penStroke(path)
  }, [draw])
  return ref
}

/** An imperfect overlapping loop around a frame. */
export function LoopMark(props: MarkProps) {
  const pen = usePen(props.draw)
  return (
    <svg className={classes('mark', props)} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path
        ref={pen}
        d="M14,9 C38,2 74,3 93,9 C99,13 98,52 96,84 C95,95 66,98 28,96 C8,95 3,78 3,48 C3,24 6,10 34,5 L47,4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** A quick tick: kept, saved. */
export function TickMark(props: MarkProps) {
  const pen = usePen(props.draw)
  return (
    <svg className={classes('mark', props)} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path
        ref={pen}
        d="M10,58 C22,66 30,76 38,90 C52,58 70,30 94,8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** A hand-drawn cross: left out. Both strokes in one path, so the pen makes them in order. */
export function StrikeMark(props: MarkProps) {
  const pen = usePen(props.draw)
  return (
    <svg className={classes('mark', props)} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path
        ref={pen}
        d="M8,10 C35,38 62,66 93,92 M90,8 C62,36 37,62 9,93"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** A short chinagraph underline: your pick, "In the timelapse". */
export function UnderlineMark(props: MarkProps) {
  const pen = usePen(props.draw)
  return (
    <svg className={classes('mark', props)} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path
        ref={pen}
        d="M3,62 C30,48 62,44 97,40"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
