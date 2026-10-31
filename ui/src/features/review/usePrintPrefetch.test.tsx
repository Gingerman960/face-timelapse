// Critique round 4, P1-4: the next two pending candidates are fetched (detail)
// and decoded (print) ahead, bounded, and what the queue moved past is
// cancelled.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { PhotoDetail, PhotoSummary, ReviewDecision } from '../../ipc/contract'
import { samples } from '../../ipc/contract.samples'
import { queryClient, queryKeys } from '../../state/queries'
import { previewSrc, printSrc } from './print'
import { keepPrints } from './printCache'
import { upcomingPending, usePrintPrefetch } from './usePrintPrefetch'

const BASE = 'ftimg://localhost/'

function photo(n: number, review: ReviewDecision = 'pending'): PhotoSummary {
  return { ...samples.PhotoSummary, id: String(n).padStart(16, '0'), status: 'uncertain', review }
}

const ids = (list: readonly PhotoSummary[]) => list.map((p) => Number(p.id))

afterEach(() => {
  keepPrints([])
})

describe('upcomingPending', () => {
  it('takes the next two pending photos after the current one, skipping decided ones', () => {
    const list = [photo(0), photo(1, 'confirmed'), photo(2), photo(3), photo(4)]
    expect(ids(upcomingPending(list, 0))).toEqual([2, 3])
  })

  it('wraps past the end of the queue', () => {
    const list = [photo(0), photo(1), photo(2), photo(3), photo(4)]
    expect(ids(upcomingPending(list, 3))).toEqual([4, 0])
  })

  it('never includes the current photo, and stops when nothing else is pending', () => {
    const list = [photo(0), photo(1, 'rejected'), photo(2)]
    expect(ids(upcomingPending(list, 0))).toEqual([2])
    expect(upcomingPending([photo(0)], 0)).toEqual([])
    expect(upcomingPending([], 0)).toEqual([])
  })
})

describe('usePrintPrefetch', () => {
  const list = [photo(0), photo(1), photo(2), photo(3), photo(4)]
  const dpr = () => window.devicePixelRatio || 1

  function spies() {
    const prefetch = vi.spyOn(queryClient, 'prefetchQuery').mockResolvedValue(undefined)
    const cancel = vi.spyOn(queryClient, 'cancelQueries').mockResolvedValue(undefined)
    const decoded: HTMLImageElement[] = []
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (this: HTMLImageElement) {
      decoded.push(this)
      return Promise.resolve()
    })
    return { prefetch, cancel, decoded }
  }

  it('fetches the details and decodes the prints of the next two pending photos only', async () => {
    // Arrange
    const { prefetch, decoded } = spies()

    // Act
    renderHook(() => usePrintPrefetch(list, 0, BASE))
    await act(async () => undefined)

    // Assert
    const keys = prefetch.mock.calls.map(([options]) => options.queryKey)
    expect(keys).toEqual([queryKeys.photo(list[1]!.id), queryKeys.photo(list[2]!.id)])
    expect(decoded.map((img) => img.getAttribute('src'))).toEqual([printSrc(BASE, list[1]!, dpr()), printSrc(BASE, list[2]!, dpr())])
  })

  // UI review 6, L3: a prefetch that resolved after the queue moved on still decoded its print,
  // and the 4-entry cache could then evict the current or next one.
  it('decodes nothing the queue has moved past by the time its detail arrives', async () => {
    // Arrange: details arrive only when released.
    const { decoded } = spies()
    const releases: Array<() => void> = []
    vi.spyOn(queryClient, 'prefetchQuery').mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)))
    const { rerender } = renderHook(({ index }) => usePrintPrefetch(list, index, BASE), { initialProps: { index: 0 } })

    // Act: two fast decisions move the window to 3 (photos 4 and 0), then the first details arrive.
    rerender({ index: 3 })
    await act(async () => {
      for (const release of releases) release()
    })

    // Assert: photos 1 and 2 (the old window) are not decoded; the new window is.
    const srcs = decoded.map((img) => img.getAttribute('src'))
    expect(srcs).not.toContain(printSrc(BASE, list[1]!, dpr()))
    expect(srcs).not.toContain(printSrc(BASE, list[2]!, dpr()))
    expect(srcs).toContain(printSrc(BASE, list[4]!, dpr()))
  })

  it('cancels what the queue moved past, and releases everything when the screen goes', async () => {
    // Arrange
    const { cancel, decoded } = spies()
    const { rerender, unmount } = renderHook(({ index }) => usePrintPrefetch(list, index, BASE), { initialProps: { index: 0 } })
    await act(async () => undefined)

    // Act: jump to photo 3 (its window is 4 and 0)
    rerender({ index: 3 })
    await act(async () => undefined)

    // Assert: 1 and 2 left the window; nothing still wanted is cancelled.
    const cancelled = () => cancel.mock.calls.map(([filters]) => filters?.queryKey)
    expect(cancelled()).toEqual([queryKeys.photo(list[1]!.id), queryKeys.photo(list[2]!.id)])
    expect(cancel.mock.calls.every(([filters]) => filters?.exact === true)).toBe(true)
    const held = () => decoded.filter((img) => img.hasAttribute('src')).map((img) => img.getAttribute('src'))
    expect(held()).toEqual([printSrc(BASE, list[4]!, dpr()), printSrc(BASE, list[0]!, dpr())])

    // Act: the screen goes
    unmount()

    // Assert
    expect(cancelled().slice(2)).toEqual([queryKeys.photo(list[4]!.id), queryKeys.photo(list[0]!.id)])
    expect(held()).toEqual([])
  })

  // Contract v1.7: a photo whose detail has a preview version decodes its preview, not its thumbnail.
  it('decodes the preview once a prefetched detail says the photo has one', async () => {
    // Arrange
    const { decoded } = spies()
    queryClient.setQueryData<PhotoDetail>(queryKeys.photo(list[1]!.id), { ...samples.PhotoDetail, summary: list[1]!, previewVersion: 'beef01' })

    // Act
    renderHook(() => usePrintPrefetch(list, 0, BASE))
    await act(async () => undefined)

    // Assert
    expect(decoded.map((img) => img.getAttribute('src'))).toEqual([previewSrc(BASE, list[1]!.id, 'beef01', dpr()), printSrc(BASE, list[2]!, dpr())])
    queryClient.removeQueries({ queryKey: queryKeys.photoAll })
  })

  it('does nothing without an image base', () => {
    const { prefetch, decoded } = spies()
    renderHook(() => usePrintPrefetch(list, 0, null))
    expect(prefetch).not.toHaveBeenCalled()
    expect(decoded).toEqual([])
  })
})
