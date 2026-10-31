// Day groups (ARCHITECTURE §9.4): the pool is the included photos, grouped by
// effective dayKey; auto pick = max score, then earliest takenAt, then relPath.
import type { DayGroup, DayKey, DaysPatch, PhotoSummary } from '../contract'
import { libraryOf } from './library'
import type { FolderState } from './state'

const cache = new WeakMap<FolderState, readonly DayGroup[]>()

/** Score desc, takenAt asc, relPath asc. */
export function comparePick(a: PhotoSummary, b: PhotoSummary): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.takenAt !== b.takenAt) return a.takenAt < b.takenAt ? -1 : 1
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
}

function buildDays(folder: FolderState): DayGroup[] {
  const { decisions } = folder
  const byDay = new Map<DayKey, PhotoSummary[]>()
  for (const photo of libraryOf(folder).photos) {
    if (!photo.included) continue
    byDay.set(photo.dayKey, [...(byDay.get(photo.dayKey) ?? []), photo])
  }
  const excluded = new Set(decisions.excludedDays)
  return [...byDay.keys()].sort().map((dayKey) => {
    const photoIds = (byDay.get(dayKey) ?? []).slice().sort(comparePick).map((p) => p.id)
    const autoSelectedId = photoIds[0] as string
    const stored = decisions.daySelections[dayKey]
    const selectedId = stored !== undefined && photoIds.includes(stored) ? stored : autoSelectedId
    return {
      dayKey,
      photoIds,
      selectedId,
      autoSelectedId,
      manualSelection: selectedId !== autoSelectedId,
      excluded: excluded.has(dayKey),
    }
  })
}

/** Days ascending, memoized per (immutable) folder state. */
export function daysOf(folder: FolderState | null): readonly DayGroup[] {
  if (!folder) return []
  const hit = cache.get(folder)
  if (hit) return hit
  const days = buildDays(folder)
  cache.set(folder, days)
  return days
}

export function findDay(folder: FolderState | null, dayKey: DayKey): DayGroup | undefined {
  return daysOf(folder).find((d) => d.dayKey === dayKey)
}

/** The patch that turns the `before` days into the `after` days for the touched keys. */
export function daysPatch(before: readonly DayGroup[], after: readonly DayGroup[], keys: readonly DayKey[]): DaysPatch {
  const unique = [...new Set(keys)].sort()
  const afterMap = new Map(after.map((d) => [d.dayKey, d]))
  const beforeKeys = new Set(before.map((d) => d.dayKey))
  return {
    upserted: unique.flatMap((k) => {
      const day = afterMap.get(k)
      return day ? [day] : []
    }),
    removed: unique.filter((k) => !afterMap.has(k) && beforeKeys.has(k)),
  }
}
