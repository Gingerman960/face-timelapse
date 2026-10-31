import { useEffect, useMemo, useRef } from 'react'
import type { PhotoDetail, PhotoId, PhotoSummary } from '../../ipc/contract'
import { photoQuery, queryClient, queryKeys } from '../../state/queries'
import { printSource } from './print'
import { decodePrint, keepPrints } from './printCache'

/** How many pending photos past the current one are fetched and decoded ahead. */
export const PREFETCH_AHEAD = 2

/** The next `count` photos still pending after `index` (wrapping), never the current one. */
export function upcomingPending(list: readonly PhotoSummary[], index: number, count = PREFETCH_AHEAD): PhotoSummary[] {
  const found: PhotoSummary[] = []
  for (let k = 1; k < list.length && found.length < count; k++) {
    const p = list[(index + k) % list.length]
    if (p?.review === 'pending') found.push(p)
  }
  return found
}

/** The query `usePhoto` reads (same key, same function), so a prefetched detail is the one the candidate finds. */
/** The detail query Review prefetches: the same key and fetch as `usePhoto` (state/queries). */
export const photoDetailQuery = photoQuery

function cancelDetail(id: PhotoId): void {
  void queryClient.cancelQueries({ queryKey: queryKeys.photo(id), exact: true })
}

/**
 * Keeps the next two pending candidates ready (critique round 4, P1-4): their
 * details are prefetched and their prints decoded, so a decision can show the
 * next print aligned at once. Bounded to the current photo and those two;
 * what the queue moves past is cancelled, and everything is released when
 * Review goes away.
 */
export function usePrintPrefetch(list: readonly PhotoSummary[], index: number, base: string | null): void {
  const current = list[index]
  const ahead = useMemo(() => upcomingPending(list, index), [list, index])
  const held = useRef<readonly PhotoSummary[]>([])
  /** The photos wanted now (the current one and the window ahead): a detail that arrives for any other decodes nothing. */
  const wantedNow = useRef<ReadonlySet<PhotoId | undefined>>(new Set())

  useEffect(() => {
    if (!base) return
    const dpr = window.devicePixelRatio || 1
    const wanted = new Set([current?.id, ...ahead.map((p) => p.id)])
    for (const p of held.current) if (!wanted.has(p.id)) cancelDetail(p.id)
    held.current = ahead
    wantedNow.current = wanted
    // What each print loads: its preview (v1.7) once its detail says it has one, else its thumbnail.
    const source = (p: PhotoSummary) => printSource(base, p, queryClient.getQueryData<PhotoDetail>(queryKeys.photo(p.id)), dpr)
    for (const p of ahead) {
      // A detail that arrives after the queue moved on decodes nothing (UI review 6, L3): the 4-entry
      // cache would otherwise evict the current or next print for one no longer wanted.
      void queryClient.prefetchQuery(photoDetailQuery(p.id)).then(() => {
        if (wantedNow.current.has(p.id)) decodePrint(source(p))
      })
    }
    keepPrints([...(current ? [current] : []), ...ahead].map(source))
  }, [base, current, ahead])

  useEffect(() => {
    const last = held
    const wanted = wantedNow
    return () => {
      for (const p of last.current) cancelDetail(p.id)
      last.current = []
      wanted.current = new Set()
      keepPrints([])
    }
  }, [])
}
