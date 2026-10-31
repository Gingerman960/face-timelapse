import { useCallback, useEffect, useRef, useState } from 'react'
import type { DayKey, PhotoId } from '../../ipc/contract'
import { isTypingTarget } from '../../hooks/useKeys'
import { clampDay, stepDay, type DayRange } from './daysModel'
import type { MovePhoto } from './useDayActions'

export interface MoveDraft {
  photoId: PhotoId
  from: DayKey
  /** The day the photo would move to. */
  target: DayKey
}

/** Arrow steps while choosing the target day: ←/→ a day, ↑/↓ a week. */
const MOVE_STEPS: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

export interface MoveMode {
  move: MoveDraft | null
  /** Starts moving `photoId` (the day's chosen photo); the target starts on the next day. */
  start: (photoId: PhotoId | undefined, from: DayKey) => void
  /** Puts the target on `day` (kept within the library), e.g. from the toolbar stepper. */
  retarget: (day: DayKey) => void
}

/**
 * Keys move mode leaves alone: typing in a field, a popover the user opened
 * (it handles its own keys, Escape included), and a modal sheet.
 */
function keysBelongElsewhere(target: EventTarget | null): boolean {
  if (isTypingTarget(target)) return true
  if (target instanceof Element && target.closest('.popover') !== null) return true
  return document.querySelector('[aria-modal="true"]') !== null
}

/** An arrow without ⌘, Ctrl or ⌥ (those stay shortcuts, e.g. ⌘↑ zoom). */
function plainArrowStep(e: KeyboardEvent): number | undefined {
  return e.metaKey || e.ctrlKey || e.altKey ? undefined : MOVE_STEPS[e.key]
}

/**
 * The keyboard path for moving a photo to another day (DESIGN: `M`, arrows,
 * Enter), the counterpart of dragging it. While it is active it owns the
 * arrows, Enter and Esc whatever has focus (a zoom segment clicked a moment
 * ago, the ribbon's range, a button): it listens in the capture phase and
 * stops those keys there, so a focused control neither handles them nor gets
 * pressed by Enter.
 */
export function useMoveMode(range: DayRange, moveTo: MovePhoto): MoveMode {
  const [move, setMoveState] = useState<MoveDraft | null>(null)
  // The latest draft for the key listener, current even between two keys React hasn't rendered yet.
  const current = useRef<MoveDraft | null>(null)
  const setMove = useCallback((next: MoveDraft | null) => {
    current.current = next
    setMoveState(next)
  }, [])
  const latest = useRef({ range, moveTo })
  useEffect(() => {
    latest.current = { range, moveTo }
  })

  const moving = move !== null
  useEffect(() => {
    if (!moving) return
    const onKey = (e: KeyboardEvent) => {
      const draft = current.current
      if (!draft || keysBelongElsewhere(e.target)) return
      const step = plainArrowStep(e)
      if (step) setMove({ ...draft, target: stepDay(draft.target, step, latest.current.range) })
      else if (e.key === 'Enter') {
        setMove(null)
        latest.current.moveTo(draft.photoId, draft.from, draft.target)
      } else if (e.key === 'Escape') setMove(null)
      else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [moving, setMove])

  const start = (photoId: PhotoId | undefined, from: DayKey) => {
    if (photoId) setMove({ photoId, from, target: stepDay(from, 1, range) })
  }
  const retarget = (day: DayKey) => {
    const draft = current.current
    if (draft) setMove({ ...draft, target: clampDay(day, range) })
  }
  return { move, start, retarget }
}
