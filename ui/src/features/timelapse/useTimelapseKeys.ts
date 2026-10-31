import type { FrameSummary } from '../../ipc/contract'
import { isActivationTarget, isMod, useKeydown } from '../../hooks/useKeys'
import { usePlayer } from '../../state/player'
import { useView } from '../../state/view'
import { runInViewTransition } from '../shell/stepTransition'
import { yearJumpIndex } from './timelapseModel'

interface TimelapseKeyOptions {
  /** Keys are off while aligning. */
  enabled: boolean
  frames: readonly FrameSummary[]
  /** The frame the UI shows (the settled playhead). */
  frame: FrameSummary | undefined
  openExport: () => void
  toggleLook: () => void
}

/** Plain letter shortcuts (no modifier) and Esc. */
function letterKey(key: string, toggleLook: () => void, openExport: () => void): void {
  const player = usePlayer.getState()
  const view = useView.getState()
  switch (key) {
    case 'j':
    case 'k':
    case 'l':
      player.shuttle(key)
      return
    case 'o':
      view.setOnion({ onion: !view.onion })
      return
    case 'd':
      view.setOnion({ onion: true, onionDifference: !view.onionDifference })
      return
    case 'a':
      view.setAnchors(!view.anchors)
      return
    case 'n':
      toggleLook()
      return
    case 'f':
      // The same print lifts to the full window and settles back (`ft-print`, critique round 4, moment 3).
      // Read inside the update: two presses before the first transition lands must toggle twice (UI review 5, L2).
      runInViewTransition(() => {
        const now = usePlayer.getState()
        now.setViewer(!now.viewer)
      })
      return
    case 'e':
      openExport()
      return
    case 'Escape':
      if (player.viewer) runInViewTransition(() => player.setViewer(false))
  }
}

/** Timelapse keyboard map: Space, arrows (⇧ ×10, ⌥ ±1 year), Home/End, J/K/L, O, D, A, N, F, E / ⌘E, Esc. */
export function useTimelapseKeys({ enabled, frames, frame, openExport, toggleLook }: TimelapseKeyOptions): void {
  useKeydown((e) => {
    const player = usePlayer.getState()
    const count = frames.length
    const take = (run: () => void) => {
      e.preventDefault()
      run()
    }
    const k = e.key
    // Space presses a focused button, chip or option; it plays only from elsewhere (UI review 2, M1).
    if (k === ' ' && isActivationTarget(e.target)) return
    if (k === ' ') return take(player.toggle)
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const dir = k === 'ArrowLeft' ? -1 : 1
      if (!e.altKey) return take(() => player.step(dir * (e.shiftKey ? 10 : 1), count))
      if (frame) take(() => player.setIndex(yearJumpIndex(frames, frame.dayKey, dir)))
      return
    }
    if (k === 'Home') return take(() => player.step(-count, count))
    if (k === 'End') return take(() => player.step(count, count))
    if (isMod(e) && k.toLowerCase() === 'e') return take(openExport)
    if (isMod(e) || e.altKey) return
    letterKey(k, toggleLook, openExport)
  }, enabled)
}
