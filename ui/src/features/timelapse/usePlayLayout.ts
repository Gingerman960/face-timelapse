import { useLayoutEffect, useRef, type RefObject } from 'react'
import { usePlayer } from '../../state/player'
import { flipDelta } from './playerLayout'

/** Fallbacks for the motion tokens (--dur-slow, --ease-sheet) when the CSS isn't there. */
const FLIP_MS = 360
const FLIP_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** The travel's timing from the motion tokens: the sheet curve, --dur-slow. */
function flipTiming(el: HTMLElement): KeyframeAnimationOptions {
  const style = getComputedStyle(el)
  const ms = parseFloat(style.getPropertyValue('--dur-slow'))
  const easing = style.getPropertyValue('--ease-sheet').trim()
  return { duration: ms > 0 ? ms : FLIP_MS, easing: easing || FLIP_EASE }
}

type ElementRef = RefObject<HTMLElement | null>

/**
 * The player's paused and playing layouts (critique round 4, P1-2). Sets
 * `data-playing` on the player (`playerRef`), which the CSS reads to fold the
 * filmstrip away while playing so the frame takes its place. The switch is
 * made the moment playback starts or stops (a store subscription, not a React
 * render), and the frame and the caption travel from where they were
 * drawn to their new boxes by transform (FLIP, --dur-slow on the sheet curve),
 * never by animating their size. A press during a travel starts the next one
 * from where the boxes are. `data-flipping` marks the travel so the transport
 * can ease to the frame's new axis. No travel under reduced motion, in the
 * full-window viewer, or where the Web Animations API is missing.
 *
 * `refit` (the stage fit, which caps the frame beside the caption) runs right
 * after the switch, so the boxes measured are the final ones.
 */
export function usePlayLayout(playerRef: ElementRef, frameRef: ElementRef, captionRef: ElementRef, refit?: () => void): void {
  const latestRefit = useRef(refit)
  useLayoutEffect(() => {
    latestRefit.current = refit
  })
  useLayoutEffect(() => {
    const player = playerRef.current
    if (!player) return
    let running: Animation[] = []
    let travel = 0

    const settle = (mine: number) => {
      if (travel === mine) delete player.dataset.flipping
    }

    const switchTo = (playing: boolean) => {
      const els = [frameRef.current, captionRef.current].filter((el): el is HTMLElement => el !== null)
      const animate = typeof player.animate === 'function' && !reducedMotion() && !usePlayer.getState().viewer
      // Measured before the switch, mid-travel included, so a reversal starts where the boxes are drawn.
      const first = animate ? els.map((el) => el.getBoundingClientRect()) : []
      running.forEach((a) => a.cancel())
      running = []
      player.dataset.playing = String(playing)
      latestRefit.current?.()
      if (!animate) return
      const timing = flipTiming(player)
      running = els.flatMap((el, i) => {
        const from = first[i]
        const d = from ? flipDelta(from, el.getBoundingClientRect()) : null
        if (!d) return []
        const start = { transformOrigin: '0 0', transform: `translate(${d.x}px, ${d.y}px) scale(${d.sx}, ${d.sy})` }
        return [el.animate([start, { transformOrigin: '0 0', transform: 'none' }], timing)]
      })
      if (running.length === 0) return
      travel += 1
      const mine = travel
      player.dataset.flipping = ''
      // A cancelled travel rejects `finished`; the next one owns the mark then.
      void Promise.all(running.map((a) => a.finished)).then(
        () => settle(mine),
        () => settle(mine),
      )
    }

    player.dataset.playing = String(usePlayer.getState().playing)
    const unsubscribe = usePlayer.subscribe((s, prev) => {
      if (s.playing !== prev.playing) switchTo(s.playing)
    })
    return () => {
      unsubscribe()
      running.forEach((a) => a.cancel())
      delete player.dataset.playing
      delete player.dataset.flipping
    }
  }, [playerRef, frameRef, captionRef])
}
