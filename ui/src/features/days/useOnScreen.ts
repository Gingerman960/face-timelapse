import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'

/** How far beyond the scrollport a section still counts as near: one screen above and one below. */
export const NEAR_MARGIN = '100% 0px'

type Ids = ReadonlySet<number>

export interface OnScreen {
  /** Sections within a screen of the view; null when that can't be known (no IntersectionObserver), so treat every one as near. */
  near: Ids | null
  /** Sections intersecting the view. */
  visible: Ids
}

const hasObserver = (): boolean => typeof IntersectionObserver !== 'undefined'

const EMPTY: Ids = new Set()

/** A set of section ids and the layout it was seen in. */
interface Keyed {
  key: string
  ids: Ids
}

/** The ids seen in this layout; none when they came from another one. */
function idsFor(state: Keyed, layoutKey: string): Ids {
  return state.key === layoutKey ? state.ids : EMPTY
}

/** An updater that folds observer entries into this layout's ids, starting empty for a new layout. */
function keyedUpdate(set: Dispatch<SetStateAction<Keyed>>, layoutKey: string): (fold: (prev: Ids | null) => Ids) => void {
  return (fold) => set((prev) => ({ key: layoutKey, ids: fold(prev.key === layoutKey ? prev.ids : EMPTY) }))
}

/** Folds observer entries into a set of section ids read from `attr`. */
function track(attr: string, update: (fold: (prev: Ids | null) => Ids) => void): IntersectionObserverCallback {
  return (entries) =>
    update((prev) => {
      const next = new Set(prev ?? [])
      for (const e of entries) {
        const id = Number(e.target.getAttribute(attr))
        if (e.isIntersecting) next.add(id)
        else next.delete(id)
      }
      return next
    })
}

/**
 * Which sections of a scrolling calendar (the Year zoom's month blocks, the
 * Decade zoom's year rows) are on screen, and which are near it. Far
 * sections drop their `<img>`s (HIGH-3): `content-visibility` skips painting
 * them but keeps their decoded images alive. `layoutKey` re-observes when the
 * set of sections changes.
 */
export function useOnScreen(container: RefObject<HTMLElement | null>, selector: string, attr: string, layoutKey: string): OnScreen {
  // Each set belongs to the layout it was seen in: new sections start empty
  // rather than inherit ids (months 1–12) that may not exist any more (UI review 2, L4).
  const [near, setNear] = useState<Keyed>(() => ({ key: layoutKey, ids: EMPTY }))
  const [visible, setVisible] = useState<Keyed>(() => ({ key: layoutKey, ids: EMPTY }))
  useEffect(() => {
    const el = container.current
    if (!el || !hasObserver()) return
    const root = el.closest('.days-canvas')
    const nearIo = new IntersectionObserver(track(attr, keyedUpdate(setNear, layoutKey)), { root, rootMargin: NEAR_MARGIN })
    const visibleIo = new IntersectionObserver(track(attr, keyedUpdate(setVisible, layoutKey)), { root, rootMargin: '0px' })
    for (const section of el.querySelectorAll(selector)) {
      nearIo.observe(section)
      visibleIo.observe(section)
    }
    return () => {
      nearIo.disconnect()
      visibleIo.disconnect()
    }
  }, [container, selector, attr, layoutKey])
  return {
    near: hasObserver() ? idsFor(near, layoutKey) : null,
    visible: idsFor(visible, layoutKey),
  }
}
