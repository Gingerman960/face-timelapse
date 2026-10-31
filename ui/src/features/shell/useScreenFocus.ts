// Critique round 5, P1-4: a plate pressed from the keyboard unmounted with its
// toolbar and focus fell to <body>. After the screen on show changes, focus
// lands on the new screen's labelled region (tabindex -1, no ring) when it
// would otherwise be lost, and the change is said politely.
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** True when focus is nowhere useful: on <body>, or on an element the old screen took with it. */
function focusLost(): boolean {
  const active = document.activeElement
  return active === null || active === document.body || !active.isConnected
}

/**
 * True when focus is lost or about to be: on an element of another screen
 * than `title` (one that unmounted, or one a Suspense boundary still holds,
 * hidden, until the new screen's code arrives).
 */
function focusLeaving(title: string): boolean {
  if (focusLost()) return true
  const owner = document.activeElement?.closest<HTMLElement>('[data-screen]')
  return owner !== null && owner !== undefined && owner.dataset.screen !== title
}

/** Set by a step change that lost focus, until the new screen (not its loading frame) has it. */
let pending = false

/**
 * Runs as the new screen commits (inside the View Transition's update, so the
 * transition captures the screen as focused). Focus inside the new screen or
 * elsewhere (the ledger, a sheet) keeps its place. Returns the polite
 * announcement: the new screen's name, empty on the first screen.
 */
export function useScreenFocus(title: string): string {
  const first = useRef(true)
  const [announcement, setAnnouncement] = useState('')
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    pending = focusLeaving(title)
    if (pending) document.querySelector<HTMLElement>(`#main > section.screen[data-screen="${CSS.escape(title)}"]`)?.focus({ preventScroll: true })
    setAnnouncement(title)
  }, [title])
  return announcement
}

/**
 * A screen's region takes the focus a step change left behind when it mounts
 * after its loading frame (without View Transitions the screen code can
 * arrive after the step changed). Once a ready screen has it, it stays put.
 */
export function useClaimScreenFocus(region: RefObject<HTMLElement | null>, busy: boolean): void {
  useLayoutEffect(() => {
    if (!pending) return
    if (focusLost()) region.current?.focus({ preventScroll: true })
    if (!busy) pending = false
  }, [region, busy])
}
