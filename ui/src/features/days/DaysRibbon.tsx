import { useCallback } from 'react'
import type { DayGroup, DayKey, PhotoSummary } from '../../ipc/contract'
import { thumbUrl } from '../../ipc/images'
import { DecadeRibbon } from '../shell/DecadeRibbon'
import type { VisibleSpan } from './CalendarViews'
import type { DayIndex } from './daysModel'
import type { DaySets } from './useDaysData'

/** The ribbon loupe's face, CSS px (DESIGN: 160 px). */
const LOUPE_PX = 160

interface DaysRibbonProps {
  index: DayIndex
  sets: DaySets
  photos: ReadonlyMap<string, PhotoSummary>
  base: string
  /** The year on screen (the ribbon's focus year). */
  year: number
  /** The selected day, or the move target while moving a photo. */
  day: DayKey
  /** The days the calendar has on screen, marked on the focus row. */
  visibleSpan: VisibleSpan | null
  onSeek: (day: DayKey) => void
}

function loupePhoto(byDay: ReadonlyMap<DayKey, DayGroup>, photos: ReadonlyMap<string, PhotoSummary>, day: DayKey): PhotoSummary | undefined {
  const group = byDay.get(day)
  return group ? photos.get(group.selectedId) : undefined
}

/** The decade ribbon under the calendar: every year of the library, what's on screen, the selected day as the cursor. */
export function DaysRibbon({ index, sets, photos, base, year, day, visibleSpan, onSeek }: DaysRibbonProps) {
  const loupeUrl = useCallback(
    (d: DayKey) => {
      const p = loupePhoto(index.byDay, photos, d)
      return p ? thumbUrl(base, { id: p.id, version: p.version }, LOUPE_PX, window.devicePixelRatio) : null
    },
    [index.byDay, photos, base],
  )
  const firstYear = index.years[0] ?? year
  const lastYear = index.years[index.years.length - 1] ?? year
  return (
    <DecadeRibbon
      start={`${firstYear}-01-01`}
      end={`${lastYear}-12-31`}
      present={sets.present}
      mine={sets.mine}
      excluded={sets.excluded}
      focusYear={year}
      cursor={day}
      visibleSpan={visibleSpan}
      onSeek={onSeek}
      loupeUrl={loupeUrl}
      label="Ten years of days"
    />
  )
}
