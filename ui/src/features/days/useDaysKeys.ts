import { useEffect, useRef } from 'react'
import type { DayGroup, DayKey, PhotoId } from '../../ipc/contract'
import { isMod, useKeydown } from '../../hooks/useKeys'
import { requestedPick } from '../../state/actions'
import type { DaysZoom } from '../../state/view'
import { stepDay, type DayRange } from './daysModel'

const ZOOMS: readonly DaysZoom[] = ['decade', 'year', 'month']
/** A day cell of the calendar grids. */
const CALENDAR_CELL = '.days-canvas [role="gridcell"]'

export interface DaysKeyOptions {
  day: DayKey
  group: DayGroup | undefined
  zoom: DaysZoom
  range: DayRange
  /** Move mode is choosing a day: it owns the arrows, Enter and Esc (see useMoveMode), and the day keys rest. */
  moving: boolean
  select: (day: DayKey) => void
  /** ⇧←/⇧→: the run of days reaches the next day (critique round 6, P1-4). */
  extend: (day: DayKey) => void
  /** Esc ends the run; null while there is none (Esc is left to other layers). */
  endRun: (() => void) | null
  choose: (photoId: PhotoId) => void
  toggleExcluded: () => void
  startMove: () => void
  setZoom: (zoom: DaysZoom) => void
  /** [ / ]: the previous or next year (DaysScreen decides what that means in each zoom). */
  stepYear: (delta: number) => void
}

/** Focus is on a day cell, or nowhere in particular: arrow navigation may carry it along. */
function focusInCalendar(): boolean {
  const el = document.activeElement
  return el === null || el === document.body || el.closest(CALENDAR_CELL) !== null
}

/**
 * Roving focus: after ←/→ the active day's cell takes DOM focus (once it has
 * rendered, which may be in another month or year), unless focus was
 * somewhere else on purpose, such as the inspector.
 */
function useFocusFollow(day: DayKey): (next: DayKey) => void {
  const pending = useRef(false)
  useEffect(() => {
    if (!pending.current) return
    pending.current = false
    document.querySelector<HTMLElement>(`${CALENDAR_CELL}[data-day="${day}"]`)?.focus()
  }, [day])
  return (next) => {
    pending.current = next !== day && focusInCalendar()
  }
}

/** The zoom one step out (⌘↑) or in (⌘↓), stopping at the ends. */
function stepZoom(zoom: DaysZoom, out: boolean): DaysZoom {
  const i = Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + (out ? -1 : 1)))
  return ZOOMS[i] ?? zoom
}

/**
 * The previous (↑) or next (↓) photo of the day, wrapping around, from the
 * pick last asked for (a held key outruns the cache, UI review 2, L3).
 */
function cyclePhoto(group: DayGroup, up: boolean): PhotoId | undefined {
  const n = group.photoIds.length
  const from = requestedPick(group.dayKey) ?? group.selectedId
  const i = group.photoIds.indexOf(from) + (up ? -1 : 1)
  return group.photoIds[(i + n) % n]
}

/** Days keys without modifiers (DESIGN keyboard map); returns true when handled. */
function plainKey(e: KeyboardEvent, o: DaysKeyOptions, follow: (next: DayKey) => void): boolean {
  const k = e.key
  const { group } = o
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault()
    const next = stepDay(o.day, k === 'ArrowLeft' ? -1 : 1, o.range)
    follow(next)
    if (e.shiftKey) o.extend(next)
    else o.select(next)
  } else if (k === 'Escape' && o.endRun) {
    o.endRun()
  } else if ((k === 'ArrowUp' || k === 'ArrowDown') && group && group.photoIds.length > 1) {
    e.preventDefault()
    const id = cyclePhoto(group, k === 'ArrowUp')
    if (id) o.choose(id)
  } else if (/^[1-9]$/.test(k) && group) {
    const id = group.photoIds[Number(k) - 1]
    if (id) o.choose(id)
  } else if (k === 'x' || k === 'X') o.toggleExcluded()
  else if (k === 'm' || k === 'M') o.startMove()
  else if (k === '[' || k === ']') o.stepYear(k === '[' ? -1 : 1)
  else return false
  return true
}

/** The Days screen's keys: ⌘↑/⌘↓ zoom (also while moving a photo), then the plain keys. */
export function useDaysKeys(o: DaysKeyOptions): void {
  const follow = useFocusFollow(o.day)
  useKeydown((e) => {
    if (isMod(e)) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      o.setZoom(stepZoom(o.zoom, e.key === 'ArrowUp'))
      return
    }
    if (!o.moving && !e.altKey) plainKey(e, o, follow)
  })
}
