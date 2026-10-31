// Continuity between screens (critique round 4, P1-8): a change of step runs
// inside a same-document View Transition, so the main column cross-fades and
// the day on show travels (`ft-day-…`, class `ft-print`: the selected day's
// aligned frame grows into the player's frame, and back). Without the API (older WebKit, tests) or with the window hidden, the
// change simply applies. Reduced motion keeps the cross-fade and drops the
// travel (CSS, base.css).
import { useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useView } from '../../state/view'
import type { Step } from '../../lib/steps'
import type { DayKey } from '../../ipc/contract'
import { loadScreen } from './screens'

interface ViewTransitionLike {
  finished: Promise<void>
  ready?: Promise<void>
  updateCallbackDone?: Promise<void>
  skipTransition?: () => void
}

type TransitionDocument = Document & { startViewTransition?: (update: () => void | Promise<void>) => ViewTransitionLike }

/** The longest a transition's new state waits for what it shows (a print being painted) before it is captured anyway. */
export const HOLD_CAP_MS = 250

/** Promises the screen being rendered inside a transition's update registered (holdTransition). */
let holds: Promise<unknown>[] | null = null

/**
 * Called while a screen renders inside a transition's update (for instance the
 * player, whose frame must be painted before the transition captures it): the
 * new state is captured once `ready` settles, or after HOLD_CAP_MS (critique
 * round 5, P1-2). Outside a transition it does nothing.
 */
export function holdTransition(ready: Promise<unknown>): void {
  holds?.push(ready)
}

/**
 * Holds a transition whose new state mounts this while `waiting` (a screen
 * still loading its data) until it stops waiting, within HOLD_CAP_MS, so no
 * transition captures a loading frame (critique round 5, P1-3).
 */
export function useTransitionHold(waiting: boolean): void {
  const release = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    if (waiting && release.current === null && holds !== null) holdTransition(new Promise<void>((resolve) => (release.current = resolve)))
    if (!waiting && release.current !== null) {
      release.current()
      release.current = null
    }
  }, [waiting])
  useLayoutEffect(() => () => release.current?.(), [])
}

/** True while a transition's update is rendering the new state (the only time a hold counts). */
export function isCapturing(): boolean {
  return holds !== null
}

/** Waits for what the new state registered, never longer than HOLD_CAP_MS. */
async function settleHolds(pending: Promise<unknown>[]): Promise<void> {
  if (pending.length === 0) return
  await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, HOLD_CAP_MS))])
}

/**
 * The transition name of a picture of `day` (critique round 5, P1-2): the
 * selected day's cell in Days and the player's frame carry it (data-vt-print,
 * --vt-print; base.css), so a screen change morphs a day into itself.
 */
export function vtPrintName(day: DayKey): string {
  return `ft-day-${day}`
}

/** Set on <html> while a transition runs: the only time elements carry their transition names. */
export const TRANSITION_CLASS = 'vt'
/** Transitions started and not yet finished (a new one skips the running one, which still settles). */
let active = 0

/** True where same-document View Transitions exist. */
export function canViewTransition(): boolean {
  return typeof (document as TransitionDocument).startViewTransition === 'function'
}

/**
 * Applies `apply` (a store update React must render) inside a View
 * Transition: the old screen is captured first, then the update renders
 * synchronously so the new one can be. A transition already running is
 * skipped by the browser in favour of this one.
 */
export function runInViewTransition(apply: () => void): void {
  const doc = document as TransitionDocument
  if (typeof doc.startViewTransition !== 'function' || document.visibilityState === 'hidden') {
    apply()
    return
  }
  // Names (`view-transition-name`) exist only while `html.vt` is set, so they
  // never make their elements stacking contexts outside a transition.
  const root = document.documentElement
  root.classList.add(TRANSITION_CLASS)
  active += 1
  const transition = doc.startViewTransition(async () => {
    holds = []
    try {
      flushSync(apply)
    } finally {
      const pending = holds
      holds = null
      await settleHolds(pending)
    }
  })
  // A transition skipped for a newer one rejects `ready` (and `finished`); that is expected, not an error.
  transition.ready?.catch(() => undefined)
  transition.updateCallbackDone?.catch(() => undefined)
  void transition.finished
    .catch(() => undefined)
    .then(() => {
      active -= 1
      if (active === 0) root.classList.remove(TRANSITION_CLASS)
    })
}

/**
 * The step whose screen is on show. The store's `step` is the target and
 * changes at once, so the step router, `afterJob` and every guard see it
 * immediately (UI review 5, H1: applying it inside the transition a frame
 * late let the router override it). Only the rendered screen follows inside
 * a View Transition, and it always catches up to the newest target, so rapid
 * changes resolve to the last one. Without the API it is the target itself.
 */
export function useShownStep(): Step {
  const step = useView((s) => s.step)
  const [shown, setShown] = useState(step)
  const animated = canViewTransition()
  useLayoutEffect(() => {
    if (!animated || shown === step) return
    // The new screen's code first, so the transition never captures a loading frame (critique round 5, P1-3).
    let live = true
    void loadScreen(step)
      .catch(() => undefined)
      .then(() => {
        if (live) runInViewTransition(() => setShown(useView.getState().step))
      })
    return () => {
      live = false
    }
  }, [animated, shown, step])
  return animated ? shown : step
}

