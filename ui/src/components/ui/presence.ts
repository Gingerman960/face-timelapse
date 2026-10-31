import { useCallback, useLayoutEffect, useRef, useState, type Key, type RefObject } from 'react'

/*
 * Exits (critique round 4, P1-3). A sheet, popover or toast that closes
 * plays a short exit, about 60 % of its entrance on --ease-in, and unmounts
 * only when it has finished. Nothing waits for it: the closing element turns
 * inert at once, focus goes back and Escape reaches the layer under it.
 * Where the browser can't animate (jsdom) it unmounts at once; under reduced
 * motion the exit is a fade with no movement.
 */

export type ExitKind = 'sheet' | 'scrim' | 'popover' | 'toast'

interface ExitSpec {
  /** Duration token on :root, and its value when the token can't be read. */
  token: string
  fallbackMs: number
  /** Where it goes as it fades (the way it came in), or null for a plain fade. */
  transform: string | null
}

const EXITS: Readonly<Record<ExitKind, ExitSpec>> = {
  sheet: { token: '--dur-exit-slow', fallbackMs: 200, transform: 'translateY(-10px) scale(0.985)' },
  scrim: { token: '--dur-exit-slow', fallbackMs: 200, transform: null },
  popover: { token: '--dur-exit-fast', fallbackMs: 100, transform: null },
  toast: { token: '--dur-exit', fallbackMs: 150, transform: 'translateY(6px) scale(0.98)' },
}

const EASE_IN_FALLBACK = 'cubic-bezier(0.4, 0, 1, 1)'
/** How long past an exit's own duration it may take before it counts as done anyway (a hidden window can hold animations). */
const EXIT_GRACE_MS = 120

/** Whether this browser can run Web Animations (jsdom can't). */
export function canAnimate(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function rootToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** A duration token in ms ("200ms", "0.2s"), read from :root so the theme's motion scale applies; `fallback` when unset. */
export function durationToken(name: string, fallback: number): number {
  const raw = rootToken(name)
  const ms = raw.endsWith('ms') ? Number.parseFloat(raw) : raw.endsWith('s') ? Number.parseFloat(raw) * 1000 : Number.NaN
  return Number.isFinite(ms) ? ms : fallback
}

/** An easing token from :root ("cubic-bezier(…)"), or `fallback` when unset. */
export function easingToken(name: string, fallback: string): string {
  return rootToken(name) || fallback
}

export function exitDuration(kind: ExitKind): number {
  const spec = EXITS[kind]
  return durationToken(spec.token, spec.fallbackMs)
}

/**
 * Plays `kind`'s exit on `el`, from wherever it is now (an exit can start
 * mid-entrance), and holds the end until the element is gone. Null where the
 * browser can't animate.
 */
export function playExit(el: Element, kind: ExitKind): Animation | null {
  if (typeof el.animate !== 'function') return null
  const spec = EXITS[kind]
  const end: Keyframe = spec.transform && !prefersReducedMotion() ? { opacity: 0, transform: spec.transform } : { opacity: 0 }
  return el.animate([end], { duration: exitDuration(kind), easing: easingToken('--ease-in', EASE_IN_FALLBACK), fill: 'forwards' })
}

/**
 * Calls `done` once, when every animation has finished, or `ms` plus a grace
 * after starting, whichever is first. The returned cancel stops them all and
 * never calls `done` (the element was opened again, or is gone).
 */
export function afterExit(animations: readonly Animation[], ms: number, done: () => void): () => void {
  let settled = false
  let timer = 0
  const settle = () => {
    if (settled) return
    settled = true
    window.clearTimeout(timer)
    done()
  }
  timer = window.setTimeout(settle, ms + EXIT_GRACE_MS)
  Promise.all(animations.map((a) => a.finished)).then(settle, () => undefined)
  return () => {
    settled = true
    window.clearTimeout(timer)
    for (const a of animations) a.cancel()
  }
}

export interface ExitTarget {
  ref: RefObject<Element | null>
  kind: ExitKind
}

/**
 * While `leaving`, plays each target's exit, then calls `done`. Opening again
 * (`leaving` false) or unmounting cancels it. Targets and `done` are read when
 * the exit starts, so callers may pass them inline.
 */
export function useExit(leaving: boolean, targets: readonly ExitTarget[], done: () => void): void {
  const latest = useRef({ targets, done })
  useLayoutEffect(() => {
    latest.current = { targets, done }
  })
  useLayoutEffect(() => {
    if (!leaving) return
    const finish = () => latest.current.done()
    const list = latest.current.targets
    const animations = list.flatMap(({ ref, kind }) => {
      const animation = ref.current ? playExit(ref.current, kind) : null
      return animation ? [animation] : []
    })
    if (animations.length === 0) {
      finish()
      return
    }
    return afterExit(animations, Math.max(...list.map((t) => exitDuration(t.kind))), finish)
  }, [leaving])
}

export interface Presence {
  /** Render it: open, or closed but still leaving. */
  mounted: boolean
  /** Closed and playing its exit: make it inert. */
  leaving: boolean
  /** The exit has finished: unmount. */
  done: () => void
}

/** Keeps something mounted after `open` turns false, until its exit calls `done` (at once where nothing can animate). */
export function usePresence(open: boolean): Presence {
  const [state, setState] = useState({ open, leaving: false })
  let leaving = state.leaving
  if (state.open !== open) {
    leaving = !open && canAnimate()
    setState({ open, leaving })
  }
  const done = useCallback(() => setState((s) => (s.leaving ? { ...s, leaving: false } : s)), [])
  return { mounted: open || leaving, leaving: !open && leaving, done }
}

export interface PresenceEntry<T> {
  item: T
  leaving: boolean
}

/** Merges the new items into the shown entries: removed ones stay in place, leaving, unless `dropAtOnce` says otherwise. */
function mergeEntries<T>(shown: ReadonlyArray<PresenceEntry<T>>, items: readonly T[], keyOf: (item: T) => Key, dropAtOnce: (gone: T) => boolean): Array<PresenceEntry<T>> {
  const fresh = new Map(items.map((item) => [keyOf(item), item]))
  const merged: Array<PresenceEntry<T>> = []
  for (const entry of shown) {
    const key = keyOf(entry.item)
    const current = fresh.get(key)
    if (current !== undefined) {
      merged.push({ item: current, leaving: false })
      fresh.delete(key)
    } else if (!dropAtOnce(entry.item)) {
      merged.push({ item: entry.item, leaving: true })
    }
  }
  return [...merged, ...items.filter((item) => fresh.has(keyOf(item))).map((item) => ({ item, leaving: false }))]
}

/**
 * A list whose removed items stay mounted, in place and `leaving`, until
 * `done(key)`. `dropAtOnce(gone, now)` lets an item go without an exit (a
 * toast merged into an identical newer one). `keyOf` must be stable.
 */
export function usePresenceList<T>(
  items: readonly T[],
  keyOf: (item: T) => Key,
  dropAtOnce?: (gone: T, now: readonly T[]) => boolean,
): { entries: ReadonlyArray<PresenceEntry<T>>; done: (key: Key) => void } {
  const [state, setState] = useState(() => ({ items, entries: items.map((item) => ({ item, leaving: false })) }))
  let entries = state.entries
  if (state.items !== items) {
    const animate = canAnimate()
    entries = mergeEntries(state.entries, items, keyOf, (gone) => !animate || (dropAtOnce?.(gone, items) ?? false))
    setState({ items, entries })
  }
  const done = useCallback(
    (key: Key) => setState((s) => ({ ...s, entries: s.entries.filter((e) => !(e.leaving && keyOf(e.item) === key)) })),
    [keyOf],
  )
  return { entries, done }
}
