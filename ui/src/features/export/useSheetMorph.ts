import { useCallback, useEffect, useLayoutEffect, useRef, type RefCallback, type RefObject } from 'react'
import { canAnimate, durationToken, easingToken, prefersReducedMotion } from '../../components/ui/presence'

/*
 * The export sheet morphs between its phases, settings → encoding → saved or
 * failed, in place (critique round 4, P1-3; it used to swap them and snap
 * its height).
 *
 * Nothing animates layout. The sheet's box takes its new height at once (or
 * keeps the old one while it shrinks) and its visible edge moves with
 * `clip-path` over 360 ms on --ease-sheet. The shadow lives on a shade under
 * the sheet that slides with the edge, so the clip never cuts it away. The
 * outgoing content is copied as it leaves and cross-fades (120 ms) with the
 * new. Under reduced motion only the cross-fade stays.
 */

const MORPH_FALLBACK_MS = 360
const XFADE_FALLBACK_MS = 120
const EASE_SHEET_FALLBACK = 'cubic-bezier(0.32, 0.72, 0, 1)'
const EASE_OUT_FALLBACK = 'cubic-bezier(0.16, 1, 0.3, 1)'
const EASE_IN_FALLBACK = 'cubic-bezier(0.4, 0, 1, 1)'
/** Room the shade's clip leaves around it for the shadow (offset 32 px, blur 80 px). */
const SHADOW_ROOM_PX = 160
/** A height change smaller than this only cross-fades. */
const MIN_MORPH_PX = 1

/** One part of a morph: its animations, and how to undo what it set when they end. */
interface Step {
  animations: Animation[]
  reset: () => void
}

/** The bottom inset of a computed `inset(…)` clip (any shorthand), or null. */
export function insetBottom(clip: string): number | null {
  const m = /^inset\(([^)]*)\)$/.exec(clip.trim())
  if (!m) return null
  const values = (m[1] ?? '').split(/\s+round\s+/)[0]?.trim().split(/\s+/).map(Number.parseFloat) ?? []
  const bottom = values[2] ?? values[0]
  return bottom !== undefined && Number.isFinite(bottom) ? bottom : null
}

/**
 * How tall the sheet looks as a new phase lands. Its box already holds the
 * new content, so outside a morph this is the height last seen; mid-morph it
 * is the morph's box less the clip it holds at the bottom right now.
 */
function visibleHeight(sheet: HTMLElement, lastSeen: number, morphBox: number | null): number {
  if (morphBox === null) return lastSeen
  return morphBox - (insetBottom(getComputedStyle(sheet).clipPath) ?? 0)
}

/** A new phase starts at its top. */
function scrollToTop(sheet: HTMLElement): void {
  sheet.scrollTop = 0
}

/** A copy of the outgoing content to fade out: no ids (they would repeat). It sits in an inert, hidden layer. */
function copyOf(node: HTMLElement): HTMLElement {
  const copy = node.cloneNode(true) as HTMLElement
  for (const el of [copy, ...copy.querySelectorAll('[id]')]) el.removeAttribute('id')
  return copy
}

/** The new content fades in while the copy of the old one, laid where it was, fades out. */
function crossFade(content: HTMLElement | null, ghost: HTMLElement | null, copy: HTMLElement | null, scrolled: number): Step {
  const duration = durationToken('--dur-xfade', XFADE_FALLBACK_MS)
  const animations: Animation[] = []
  if (content) animations.push(content.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: easingToken('--ease-out', EASE_OUT_FALLBACK), fill: 'backwards' }))
  if (ghost && copy) {
    ghost.style.top = `${(content?.offsetTop ?? 0) - scrolled}px`
    ghost.replaceChildren(copy)
    animations.push(copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: easingToken('--ease-in', EASE_IN_FALLBACK), fill: 'forwards' }))
  }
  return { animations, reset: () => ghost?.replaceChildren() }
}

/** The edge moves from `from` to `to` inside a box `box` tall: a clip on the sheet, and the shade sliding under it. */
function moveEdge(sheet: HTMLElement, shade: HTMLElement | null, from: number, to: number, box: number): Step {
  const radius = Number.parseFloat(getComputedStyle(sheet).borderTopLeftRadius) || 0
  if (to < from) sheet.style.minHeight = `${from}px`
  sheet.dataset.morph = 'true'
  sheet.style.willChange = 'clip-path'
  const timing: KeyframeAnimationOptions = {
    duration: durationToken('--dur-slow', MORPH_FALLBACK_MS),
    easing: easingToken('--ease-sheet', EASE_SHEET_FALLBACK),
    fill: 'forwards',
  }
  const [start, end] = [box - from, box - to]
  const cut = (d: number) => ({ clipPath: `inset(0px 0px ${d}px 0px round ${radius}px)` })
  const animations = [sheet.animate([cut(start), cut(end)], timing)]
  if (shade) {
    const room = `${-SHADOW_ROOM_PX}px`
    const lift = (d: number) => ({ transform: `translateY(${d === 0 ? 0 : -d}px)`, clipPath: `inset(${d}px ${room} ${room} ${room})` })
    shade.style.willChange = 'transform, clip-path'
    animations.push(shade.animate([lift(start), lift(end)], timing))
  }
  return {
    animations,
    reset: () => {
      sheet.style.removeProperty('min-height')
      sheet.style.removeProperty('will-change')
      delete sheet.dataset.morph
      shade?.style.removeProperty('will-change')
    },
  }
}

/**
 * Morphs the sheet whenever `phase` changes. Give the returned ref to the
 * phase's content wrapper, keyed by the phase: as a wrapper leaves (React 19
 * ref cleanup, while it is still whole) its content is copied for the
 * cross-fade. `ghost` is an empty, inert layer inside the sheet for that copy;
 * `shade` carries the sheet's shadow.
 */
export function useSheetMorph(
  sheet: RefObject<HTMLElement | null>,
  shade: RefObject<HTMLElement | null>,
  ghost: RefObject<HTMLElement | null>,
  phase: string,
): RefCallback<HTMLElement> {
  const content = useRef<HTMLElement | null>(null)
  const outgoing = useRef<HTMLElement | null>(null)
  const shown = useRef(phase)
  const scrolled = useRef(0)
  /** The sheet's height as last seen outside a morph. */
  const seen = useRef(0)
  /** The box a running morph holds, or null. */
  const morphBox = useRef<number | null>(null)
  const stop = useRef<(() => void) | null>(null)

  const phaseRef = useCallback((node: HTMLElement | null) => {
    if (!node) return
    content.current = node
    return () => {
      if (content.current === node) content.current = null
      outgoing.current = canAnimate() ? copyOf(node) : null
    }
  }, [])

  // The height as the sheet settles (fields folding open, notices), and where it is scrolled to.
  useLayoutEffect(() => {
    const el = sheet.current
    if (!el) return
    const measure = () => {
      if (morphBox.current === null) seen.current = el.getBoundingClientRect().height
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    const onScroll = () => {
      scrolled.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', onScroll)
    }
  }, [sheet])

  useLayoutEffect(() => {
    if (shown.current === phase) return
    shown.current = phase
    const el = sheet.current
    const copy = outgoing.current
    outgoing.current = null
    if (!el || !canAnimate()) return
    const from = visibleHeight(el, seen.current, morphBox.current)
    stop.current?.()
    const scroll = scrolled.current
    scrollToTop(el)
    scrolled.current = 0
    const to = el.getBoundingClientRect().height
    const steps = [crossFade(content.current, ghost.current, copy, scroll)]
    if (!prefersReducedMotion() && Math.abs(to - from) >= MIN_MORPH_PX) {
      morphBox.current = Math.max(from, to)
      steps.push(moveEdge(el, shade.current, from, to, morphBox.current))
    }
    const animations = steps.flatMap((s) => s.animations)
    let over = false
    const end = () => {
      if (over) return
      over = true
      for (const a of animations) a.cancel()
      for (const s of steps) s.reset()
      morphBox.current = null
      seen.current = el.getBoundingClientRect().height
      if (stop.current === end) stop.current = null
    }
    stop.current = end
    Promise.all(animations.map((a) => a.finished)).then(end, () => undefined)
  }, [phase, sheet, shade, ghost])

  useEffect(() => () => stop.current?.(), [])

  return phaseRef
}
