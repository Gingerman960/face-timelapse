// The verdict's flight (critique round 4, signature moment 2): the decided
// print leaves the light table for its slot on the film, on transform and
// opacity only, after the pen has started its mark.

/** A box in the verdict layer's coordinates. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface FlightPlan {
  /** Null under reduced motion: nothing moves. */
  transform: Keyframe[] | null
  opacity: Keyframe[]
  timing: KeyframeAnimationOptions
  opacityTiming: KeyframeAnimationOptions
}

/** The pen gets going on the big print before it lifts off. */
export const FLIGHT_DELAY_MS = 120
export const FLIGHT_MS = 280
/** Reduced motion: no movement, a short fade (DESIGN: 120 ms cross-fades). */
export const REDUCED_FADE_MS = 120
/** A left-out frame on the film: greyscale at 35 % (review.css `.q-item.out`). */
export const LEFT_OUT_OPACITY = 0.35
/** `--ease-out`: arrivals. */
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'
/** Where a print with no slot in view goes: it settles a little and fades. */
const SINK = 'translateY(12px) scale(0.96)'
/** The print keeps its look until this far into the flight, then hands over to the slot. */
const HANDOVER = 0.7

function num(x: number): string {
  return String(Number(x.toFixed(3)))
}

/** The transform (origin top left) that sets `from` on `to`: centres meet, heights match. */
function landing(from: Box, to: Box): string {
  const s = to.height / from.height
  const tx = to.left + to.width / 2 - (from.left + (from.width * s) / 2)
  const ty = to.top + to.height / 2 - (from.top + (from.height * s) / 2)
  return `translate(${num(tx)}px, ${num(ty)}px) scale(${s})`
}

/**
 * How the print decided at `from` flies to its queue slot `to` (null when the
 * slot isn't in view). A kept print stays bright until it reaches the film; a
 * left-out one dims to the film's 35 % on the way. Both dissolve into the
 * slot, where the queue's own mark is being written.
 */
export function flightPlan(from: Box, to: Box | null, review: 'confirmed' | 'rejected', reduced: boolean): FlightPlan {
  if (reduced) {
    const fade: KeyframeAnimationOptions = { duration: REDUCED_FADE_MS, delay: 0, easing: 'linear', fill: 'both' }
    return { transform: null, opacity: [{ opacity: 1 }, { opacity: 0 }], timing: fade, opacityTiming: fade }
  }
  const timing: KeyframeAnimationOptions = { duration: FLIGHT_MS, delay: FLIGHT_DELAY_MS, easing: EASE_OUT, fill: 'both' }
  const kept = review === 'confirmed' ? 1 : LEFT_OUT_OPACITY
  return {
    transform: [{ transform: 'none' }, { transform: to ? landing(from, to) : SINK }],
    opacity: [
      { opacity: 1, offset: 0 },
      { opacity: kept, offset: HANDOVER },
      { opacity: 0, offset: 1 },
    ],
    timing,
    opacityTiming: { ...timing, easing: 'linear' },
  }
}
