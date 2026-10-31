// The live sheet follows the newest frame on a critically damped spring
// (critique round 4, P2-15): it used to jump a row at a time, about four
// times a second. One rAF loop writes scrollTop; a new target retargets it
// mid-flight, keeping its speed; a scroll it didn't write stops it.
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'

/** Spring stiffness, rad/s: a critically damped follow is within 2 % of a new target after about 250 ms. */
const FOLLOW_OMEGA = 24
/** A frame longer than this (a stall, a hidden window) steps as if it were this long. */
const MAX_FRAME_MS = 64
const FIRST_FRAME_MS = 1000 / 60
/** Close enough and slow enough to land. */
const SETTLE_PX = 0.5
const SETTLE_SPEED = 20
/** A scroll position this far from the one written was moved by someone else (rounding stays well inside it). */
const FOREIGN_SCROLL_PX = 3

/** Position (px) and velocity (px/s). */
export interface DampState {
  readonly pos: number
  readonly vel: number
}

/**
 * One exact step of a critically damped spring toward `target` (no overshoot
 * from rest, stable for any frame length): x(t) = target + (x₀ + (v₀ + ωx₀)t)e^(−ωt)
 * with x measured from the target.
 */
export function dampStep(s: DampState, target: number, dtMs: number, omega = FOLLOW_OMEGA): DampState {
  const dt = Math.min(MAX_FRAME_MS, Math.max(0, dtMs)) / 1000
  const delta = s.pos - target
  const temp = (s.vel + omega * delta) * dt
  const decay = Math.exp(-omega * dt)
  return { pos: target + (delta + temp) * decay, vel: (s.vel - omega * temp) * decay }
}

/** True once the follow can land on its target without a visible step. */
export function isSettled(s: DampState, target: number): boolean {
  return Math.abs(s.pos - target) < SETTLE_PX && Math.abs(s.vel) < SETTLE_SPEED
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** Follows a scroll target; `stop` lets the user's own scrolling win. */
export interface Follow {
  to: (target: number) => void
  stop: () => void
}

interface Flight {
  raf: number
  state: DampState
  target: number
  /** The previous frame's time, null before the first frame. */
  last: number | null
  /** The scrollTop this loop wrote last, as the element reported it back. */
  written: number
}

function createFollow(element: () => HTMLElement | null, onScrollBack: () => void): Follow {
  let flight: Flight | null = null

  const stop = () => {
    if (flight) window.cancelAnimationFrame(flight.raf)
    flight = null
  }

  const tick = (now: number) => {
    const el = element()
    if (!el || !flight) return
    let state = flight.state
    const top = el.scrollTop
    if (Math.abs(top - flight.written) > FOREIGN_SCROLL_PX) {
      // At the end of the content, the browser clamped it (the sheet got shorter): carry on from there.
      const atEnd = el.scrollHeight - el.clientHeight - top <= 1
      if (!atEnd) {
        const back = top < flight.written
        stop()
        if (back) onScrollBack()
        return
      }
      state = { pos: top, vel: 0 }
    }
    const next = dampStep(state, flight.target, flight.last === null ? FIRST_FRAME_MS : now - flight.last)
    if (isSettled(next, flight.target)) {
      el.scrollTop = flight.target
      stop()
      return
    }
    el.scrollTop = next.pos
    flight = { ...flight, state: next, last: now, written: el.scrollTop, raf: window.requestAnimationFrame(tick) }
  }

  const to = (target: number) => {
    const el = element()
    if (!el) return
    if (flight) {
      flight = { ...flight, target }
      return
    }
    if (prefersReducedMotion() || typeof window.requestAnimationFrame !== 'function') {
      el.scrollTop = target
      return
    }
    if (Math.abs(el.scrollTop - target) < SETTLE_PX) return
    flight = { raf: window.requestAnimationFrame(tick), state: { pos: el.scrollTop, vel: 0 }, target, last: null, written: el.scrollTop }
  }

  return { to, stop }
}

/**
 * A damped scroll follower for `scroller`. `onScrollBack` runs when the user
 * scrolls back against it (a scrollbar drag the wheel and key handlers can't
 * see), so the caller can stop following. Reduced motion jumps instead.
 */
export function useDampedFollow(scroller: RefObject<HTMLElement | null>, onScrollBack?: () => void): Follow {
  const back = useRef(onScrollBack)
  useEffect(() => {
    back.current = onScrollBack
  }, [onScrollBack])
  // The loop lives outside React: made after mount, stopped on unmount, reached through stable callbacks.
  const engine = useRef<Follow | null>(null)
  useEffect(() => {
    const follow = createFollow(
      () => scroller.current,
      () => back.current?.(),
    )
    engine.current = follow
    return () => {
      follow.stop()
      engine.current = null
    }
  }, [scroller])
  const to = useCallback((target: number) => engine.current?.to(target), [])
  const stop = useCallback(() => engine.current?.stop(), [])
  return useMemo(() => ({ to, stop }), [to, stop])
}
