import { useLayoutEffect } from 'react'
import { usePlayer } from '../../state/player'

/** Stillness while playing before the chrome dims again, and before the pointer hides (critique round 4, signature moment 1). */
export const LIGHTS_IDLE_MS = 2000

/** Anything the person does that brings the chrome back. Pointer moves are filtered (see below). */
const WAKE_EVENTS = ['pointerdown', 'keydown', 'wheel', 'focusin'] as const

type Lights = 'on' | 'out'

/**
 * Lights-out playback. While `enabled` (the player is on screen), sets
 * `html[data-lights]`: "out" while playing and still, "on" otherwise; the CSS
 * (timelapse.css) fades the sidebar, toolbar, transport, caption facts and
 * the ribbon (all but its playhead) to 8 % while it reads "out", and in the
 * light theme switches the table off too (critique round 5, P1-8). A pointer
 * move, a key, a wheel or a focus change restores it, and it dims again
 * after LIGHTS_IDLE_MS of stillness while playing. Pausing restores it; the
 * attribute is removed when the player goes away.
 *
 * While the lights are out and nothing has moved for LIGHTS_IDLE_MS, the
 * pointer hides too (`html[data-pointer="hidden"]`, critique round 5, P2-17);
 * the next move, key or pause brings it back.
 *
 * Listeners run in the capture phase on window, so the key that starts
 * playback (Space, L) wakes first and the start of playback then dims: the
 * order is fixed, whatever the screen's own handlers do. A layout effect, so
 * the lights also come back while React keeps the screen hidden behind a
 * Suspense fallback on the way to another screen (passive effects outlive that).
 */
export function useLightsOut(enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled) return
    const root = document.documentElement
    let timer: ReturnType<typeof setTimeout> | undefined
    let stillTimer: ReturnType<typeof setTimeout> | undefined
    // Nothing has moved, been pressed or focused for LIGHTS_IDLE_MS.
    let still = false
    let pointer: { x: number; y: number } | null = null
    // Attributes are written only when they change: a pointer move wakes on every event.
    const syncPointer = () => {
      const hide = still && root.dataset.lights === 'out'
      if (hide && root.dataset.pointer !== 'hidden') root.dataset.pointer = 'hidden'
      else if (!hide && root.dataset.pointer !== undefined) delete root.dataset.pointer
    }
    const set = (value: Lights) => {
      if (root.dataset.lights !== value) root.dataset.lights = value
      syncPointer()
    }
    const active = () => {
      still = false
      clearTimeout(stillTimer)
      stillTimer = setTimeout(() => {
        still = true
        syncPointer()
      }, LIGHTS_IDLE_MS)
    }
    const dimLater = () => {
      clearTimeout(timer)
      timer = setTimeout(() => set('out'), LIGHTS_IDLE_MS)
    }
    const wake = () => {
      active()
      set('on')
      if (usePlayer.getState().playing) dimLater()
      else clearTimeout(timer)
    }
    // WebKit re-sends pointer events when content moves under a still pointer: only a real move wakes.
    const onPointerMove = (e: PointerEvent) => {
      const moved = pointer === null || pointer.x !== e.clientX || pointer.y !== e.clientY
      pointer = { x: e.clientX, y: e.clientY }
      if (moved) wake()
    }
    wake()
    const unsubscribe = usePlayer.subscribe((s, prev) => {
      if (s.playing === prev.playing) return
      clearTimeout(timer)
      set(s.playing ? 'out' : 'on')
    })
    const capture = { capture: true, passive: true } as const
    window.addEventListener('pointermove', onPointerMove, capture)
    for (const type of WAKE_EVENTS) window.addEventListener(type, wake, capture)
    return () => {
      unsubscribe()
      clearTimeout(timer)
      clearTimeout(stillTimer)
      window.removeEventListener('pointermove', onPointerMove, capture)
      for (const type of WAKE_EVENTS) window.removeEventListener(type, wake, capture)
      delete root.dataset.lights
      delete root.dataset.pointer
    }
  }, [enabled])
}
