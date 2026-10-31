// The screens, code-split and preloadable (critique round 4, P1-8: the first
// visit to a screen flashed an empty Suspense frame). Each screen's code is
// fetched while the app is idle after start, and again on a hover over its
// ledger row; a screen whose code is already here renders directly, with no
// Suspense round trip, so a View Transition captures the real screen.
import { lazy, useState, type ComponentType } from 'react'
import type { Step } from '../../lib/steps'

type ScreenModule = { default: ComponentType }

interface Preloadable {
  /** Fetches the screen's code (once); resolves with the component. */
  load: () => Promise<ComponentType>
  /** The screen: direct when its code is here at mount, else lazy. */
  Component: ComponentType
}

/** A screen whose code is fetched once, ahead of a visit when asked; a failed fetch is tried again next time (UI review 5, L3). */
export function preloadable(loader: () => Promise<ScreenModule>): Preloadable {
  let loaded: ComponentType | null = null
  let pending: Promise<ComponentType> | null = null
  const load = () => {
    pending ??= loader().then(
      (m) => {
        loaded = m.default
        return m.default
      },
      (error: unknown) => {
        pending = null
        throw error
      },
    )
    return pending
  }
  const Lazy = lazy(() => load().then((C) => ({ default: C })))
  function Component() {
    // Decided once per mount: switching from lazy to direct later would remount the screen.
    const [Direct] = useState(() => loaded)
    return Direct ? <Direct /> : <Lazy />
  }
  return { load, Component }
}

const setup = preloadable(() => import('../setup/SetupScreen'))
const scan = preloadable(() => import('../scan/ScanScreen'))
const review = preloadable(() => import('../review/ReviewScreen'))
const days = preloadable(() => import('../days/DaysScreen'))
const timelapse = preloadable(() => import('../timelapse/TimelapseScreen'))

const SCREENS: Record<Step, Preloadable> = { setup, scan, review, days, align: timelapse, timelapse }

export const SetupScreen = setup.Component
export const ScanScreen = scan.Component
export const ReviewScreen = review.Component
export const DaysScreen = days.Component
export const TimelapseScreen = timelapse.Component

/** Fetches a step's screen code ahead of a visit (a ledger hover). Failures surface on the visit itself. */
export function preloadScreen(step: Step): void {
  void SCREENS[step].load().catch(() => undefined)
}

/** Resolves once a step's screen code is here (a transition waits for it before it starts). */
export function loadScreen(step: Step): Promise<ComponentType> {
  return SCREENS[step].load()
}

/** When the browser can't say when it is idle (WebKit may lack requestIdleCallback), after this long. */
export const IDLE_FALLBACK_MS = 800

/** Fetches every screen's code once the app is idle (where the browser can say when that is). */
export function preloadScreensWhenIdle(): () => void {
  const all = () => {
    for (const step of ['days', 'timelapse', 'review', 'scan', 'setup'] as const) preloadScreen(step)
  }
  if (typeof window.requestIdleCallback !== 'function') {
    const timer = setTimeout(all, IDLE_FALLBACK_MS)
    return () => clearTimeout(timer)
  }
  const id = window.requestIdleCallback(all)
  return () => window.cancelIdleCallback(id)
}
