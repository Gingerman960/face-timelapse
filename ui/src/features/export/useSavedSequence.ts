import { useEffect, useRef, useState } from 'react'
import { durationToken, prefersReducedMotion } from '../../components/ui/presence'

/*
 * Saved, as one sequence (critique round 5, P2-11; signature moment 5). The
 * pen used to tick on a fixed 280 ms timer, often onto unexposed prints, and
 * the copy came before the pictures. Now:
 *
 *   waiting  the window isn't seen yet (a long encode that finished in the
 *            background): nothing moves until it is shown and focused
 *   latent   both prints are unexposed film; the phase's cross-fade lands first
 *   first    the first print develops, once its image is in
 *   both     the last print develops 240 ms later, once its image is in
 *   inked    the pen ticks the pair at 60 % of the last print's develop
 *   told     the facts arrive as the pen lifts
 *
 * Images that never arrive hold the moment for 2 s at most, so the facts
 * always come. Under reduced motion nothing staggers: the prints are there,
 * the tick fades in over 120 ms and the facts follow it.
 */

export type SavedStage = 'waiting' | 'latent' | 'first' | 'both' | 'inked' | 'told'

const ORDER: readonly SavedStage[] = ['waiting', 'latent', 'first', 'both', 'inked', 'told']

export interface SavedTiming {
  /** After the window is seen: the phase's cross-fade lands before the first print develops. */
  startMs: number
  /** The last print develops this long after the first. */
  staggerMs: number
  /** The pen writes this long into the last print's develop. */
  inkMs: number
  /** The pen's stroke: the facts come as it lifts. */
  penMs: number
  /** Longest wait for the images before the moment goes on without them. */
  capMs: number
}

export interface SavedTokens {
  developMs: number
  penMs: number
  xfadeMs: number
}

const STAGGER_MS = 240
/** The pen writes at 60 % of the last print's develop, when the face is up but still surfacing. */
const INK_AT = 0.6
const REDUCED_PEN_MS = 120
const IMAGE_CAP_MS = 2000

const DEVELOP_FALLBACK_MS = 700
const PEN_FALLBACK_MS = 360
const XFADE_FALLBACK_MS = 120

/** The sequence's timing from the motion tokens; reduced motion keeps the order, not the movement. */
export function savedTiming(tokens: SavedTokens, reduced: boolean): SavedTiming {
  if (reduced) return { startMs: 0, staggerMs: 0, inkMs: 0, penMs: REDUCED_PEN_MS, capMs: IMAGE_CAP_MS }
  return { startMs: tokens.xfadeMs, staggerMs: STAGGER_MS, inkMs: Math.round(INK_AT * tokens.developMs), penMs: tokens.penMs, capMs: IMAGE_CAP_MS }
}

/**
 * The stage after `stage` and how long after entering `stage` it comes; null
 * while it waits (for the window to be seen, or for an image).
 */
export function nextSavedStep(
  stage: SavedStage,
  ready: readonly [boolean, boolean],
  seen: boolean,
  t: SavedTiming,
): { stage: SavedStage; afterMs: number } | null {
  switch (stage) {
    case 'waiting':
      return seen ? { stage: 'latent', afterMs: t.startMs } : null
    case 'latent':
      return ready[0] ? { stage: 'first', afterMs: 0 } : null
    case 'first':
      return ready[1] ? { stage: 'both', afterMs: t.staggerMs } : null
    case 'both':
      return { stage: 'inked', afterMs: t.inkMs }
    case 'inked':
      return { stage: 'told', afterMs: t.penMs }
    case 'told':
      return null
  }
}

/** Whether `stage` is at or past `mark`. */
function reached(stage: SavedStage, mark: SavedStage): boolean {
  return ORDER.indexOf(stage) >= ORDER.indexOf(mark)
}

/** Whether print `i` (0 first, 1 last) is developing or developed. */
export function printExposed(stage: SavedStage, i: 0 | 1): boolean {
  return reached(stage, i === 0 ? 'first' : 'both')
}

/** Whether the pen has ticked the prints. */
export function inked(stage: SavedStage): boolean {
  return reached(stage, 'inked')
}

/** Whether the facts are shown. */
export function told(stage: SavedStage): boolean {
  return stage === 'told'
}

/** Seen: the page is visible and the window has focus (WKWebView reports an occluded window as hidden). */
function isSeen(): boolean {
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true
  return document.visibilityState === 'visible' && focused
}

/** True once the window has been seen since mount; it stays true. */
function useSeen(): boolean {
  const [seen, setSeen] = useState(isSeen)
  useEffect(() => {
    if (seen) return
    const check = () => {
      if (isSeen()) setSeen(true)
    }
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [seen])
  return seen
}

/** The timing from the tokens on :root, read once (the theme's motion scale applies). */
function readTiming(): SavedTiming {
  const tokens = {
    developMs: durationToken('--dur-develop', DEVELOP_FALLBACK_MS),
    penMs: durationToken('--dur-pen', PEN_FALLBACK_MS),
    xfadeMs: durationToken('--dur-xfade', XFADE_FALLBACK_MS),
  }
  return savedTiming(tokens, prefersReducedMotion())
}

/**
 * Runs the saved moment and returns its stage. `loaded` says which prints'
 * images are in; `enabled` false (no prints to show) skips to the facts.
 */
export function useSavedSequence(loaded: readonly [boolean, boolean], enabled = true): SavedStage {
  const seen = useSeen()
  const [timing] = useState(readTiming)
  const [stage, setStage] = useState<SavedStage>(enabled ? 'waiting' : 'told')
  const [gaveUp, setGaveUp] = useState(false)
  // When the current stage began, and when the film started waiting for its images.
  const entered = useRef<number | null>(null)
  const startedAt = useRef<number | null>(null)
  useEffect(() => {
    entered.current ??= Date.now()
  }, [])

  const ready: [boolean, boolean] = [loaded[0] || gaveUp, loaded[1] || gaveUp]
  const [ready0, ready1] = ready
  const allIn = loaded[0] && loaded[1]
  const waitingForImages = reached(stage, 'latent') && !reached(stage, 'both')

  // The images get IMAGE_CAP_MS from the moment the film shows.
  useEffect(() => {
    if (!waitingForImages || allIn || gaveUp) return
    const wait = Math.max(0, (startedAt.current ?? Date.now()) + timing.capMs - Date.now())
    const timer = window.setTimeout(() => setGaveUp(true), wait)
    return () => window.clearTimeout(timer)
  }, [waitingForImages, allIn, gaveUp, timing])

  useEffect(() => {
    const next = nextSavedStep(stage, [ready0, ready1], seen, timing)
    if (!next) return
    const wait = Math.max(0, (entered.current ?? Date.now()) + next.afterMs - Date.now())
    const timer = window.setTimeout(() => {
      const now = Date.now()
      entered.current = now
      if (next.stage === 'latent') startedAt.current = now
      setStage(next.stage)
    }, wait)
    return () => window.clearTimeout(timer)
  }, [stage, ready0, ready1, seen, timing])

  return stage
}
