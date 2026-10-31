import type { DropAnimationKeyframeResolver } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'

/** How long a dropped photo takes to settle into its day. */
const SETTLE_MS = 220
/** The ghost's size as it settles: it sinks into the day rather than vanishing. */
const SETTLE_SCALE = 0.72

/**
 * A dropped photo settles into the day under the pointer (critique round 4): the ghost shrinks
 * and fades where it was let go (220 ms, ease-out), instead of vanishing or flying back to where
 * the drag began. Reduced motion: no settle.
 */
/** A drop animation that is an options object (dnd-kit also accepts a function). */
export interface DropSettle {
  duration: number
  easing: string
  keyframes: DropAnimationKeyframeResolver
}

export function dropSettle(): DropSettle | null {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null
  return {
    duration: SETTLE_MS,
    easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    keyframes: ({ transform }) => [
      { opacity: 1, transform: CSS.Transform.toString(transform.initial) },
      { opacity: 0, transform: CSS.Transform.toString({ ...transform.initial, scaleX: SETTLE_SCALE, scaleY: SETTLE_SCALE }) },
    ],
  }
}
