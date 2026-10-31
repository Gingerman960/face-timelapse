import { useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DayGroup, DayKey, PhotoSummary } from '../../ipc/contract'
import { useAppInfo, useDays, usePhotos, useSession } from '../../state/queries'
import { useView } from '../../state/view'
import { indexDays, type DayRange } from './daysModel'

export interface DaySets {
  /** Days that have a photo (memoized: the ribbon redraws only when this changes). */
  present: ReadonlySet<DayKey>
  mine: ReadonlySet<DayKey>
  excluded: ReadonlySet<DayKey>
}

function daySets(days: readonly DayGroup[]): DaySets {
  const present = new Set<DayKey>()
  const mine = new Set<DayKey>()
  const excluded = new Set<DayKey>()
  for (const d of days) {
    present.add(d.dayKey)
    if (d.manualSelection) mine.add(d.dayKey)
    if (d.excluded) excluded.add(d.dayKey)
  }
  return { present, mine, excluded }
}

/** Everything Days reads from the backend, indexed once per change. */
export function useDaysData() {
  const session = useSession().data
  const info = useAppInfo().data
  const days = useDays().data
  const photos = usePhotos(null).data
  const index = useMemo(() => indexDays(days ?? []), [days])
  const range = useMemo<DayRange>(() => ({ first: index.first, last: index.last }), [index])
  const photoMap = useMemo(() => new Map<string, PhotoSummary>((photos ?? []).map((p) => [p.id, p])), [photos])
  const sets = useMemo(() => daySets(days ?? []), [days])
  return { session, info, days, index, range, photoMap, sets }
}

/**
 * The Days fields of the view store, compared shallowly, so toasts and other
 * screens' view state don't re-render the calendar.
 */
export function useDaysView() {
  return useView(
    useShallow((s) => ({
      activeDay: s.activeDay,
      daysZoom: s.daysZoom,
      daysYear: s.daysYear,
      setActiveDay: s.setActiveDay,
      setDaysZoom: s.setDaysZoom,
      setDaysYear: s.setDaysYear,
    })),
  )
}

/**
 * Where Days opens (QA 11): on the selected day's year when a day is selected
 * (also when it was chosen elsewhere, e.g. the timelapse's "Replace this
 * day's photo", while another year was left in view), otherwise on the most
 * recent day, so the most recent year shows. `select` sets the day and its
 * year; the calendar scrolls that day's month into view.
 */
export function useLanding(days: readonly DayGroup[] | undefined, activeDay: DayKey | null, select: (day: DayKey) => void): void {
  const landed = useRef(false)
  useEffect(() => {
    if (!days || days.length === 0) return
    if (activeDay && landed.current) return
    landed.current = true
    const day = activeDay ?? days[days.length - 1]?.dayKey
    if (day) select(day)
  }, [activeDay, days, select])
}
