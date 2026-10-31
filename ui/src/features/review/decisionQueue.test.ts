// M3 (UI review #1): review decisions are optimistic, batched on 300 ms of
// idle time (DESIGN), rolled back on failure, and the photo list is only
// re-read after the last batch, so a refetch can't resurrect a decided photo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhotoId, ReviewDecision } from '../../ipc/contract'
import { createDecisionQueue, REVIEW_BATCH_IDLE_MS } from './decisionQueue'

function harness(send = vi.fn((_ids: PhotoId[], _d: ReviewDecision) => Promise.resolve())) {
  const shown = new Map<PhotoId, ReviewDecision>([
    ['a', 'pending'],
    ['b', 'pending'],
    ['c', 'pending'],
  ])
  const apply = vi.fn((ids: readonly PhotoId[], d: ReviewDecision) => ids.forEach((id) => shown.set(id, d)))
  const settle = vi.fn()
  const onError = vi.fn()
  const queue = createDecisionQueue({ send, apply, settle, onError, current: (id) => shown.get(id) ?? 'pending' })
  return { queue, send, apply, settle, onError, shown }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createDecisionQueue', () => {
  it('shows decisions at once and sends them as one batch per decision after 300 ms idle', async () => {
    const { queue, send, shown, settle } = harness()
    queue.decide(['a'], 'confirmed')
    vi.advanceTimersByTime(REVIEW_BATCH_IDLE_MS - 50)
    queue.decide(['b'], 'confirmed')
    queue.decide(['c'], 'rejected')
    expect(shown.get('a')).toBe('confirmed')
    expect(send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(REVIEW_BATCH_IDLE_MS)

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith(['a', 'b'], 'confirmed')
    expect(send).toHaveBeenCalledWith(['c'], 'rejected')
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('a later decision on the same photo replaces the queued one (undo within the batch)', async () => {
    const { queue, send } = harness()
    queue.decide(['a'], 'confirmed')
    queue.decide(['a'], 'pending')
    await vi.advanceTimersByTimeAsync(REVIEW_BATCH_IDLE_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(['a'], 'pending')
  })

  it('rolls back to the last confirmed state and reports when a batch fails', async () => {
    const send = vi.fn((_ids: PhotoId[], d: ReviewDecision) => (d === 'rejected' ? Promise.reject(new Error('disk full')) : Promise.resolve()))
    const { queue, shown, onError } = harness(send)
    queue.decide(['a'], 'confirmed')
    queue.decide(['b'], 'rejected')
    await vi.advanceTimersByTimeAsync(REVIEW_BATCH_IDLE_MS)
    expect(shown.get('a')).toBe('confirmed')
    expect(shown.get('b')).toBe('pending')
    expect(onError).toHaveBeenCalledTimes(1)
    // It names the photos it rolled back (their undo entries go: UI review 4, L3).
    expect(onError).toHaveBeenCalledWith(expect.any(Error), ['b'])
  })

  it('does not re-read the list while more decisions are queued', async () => {
    let release: () => void = () => undefined
    const send = vi.fn(() => new Promise<void>((r) => (release = r)))
    const { queue, settle } = harness(send)
    queue.decide(['a'], 'confirmed')
    await vi.advanceTimersByTimeAsync(REVIEW_BATCH_IDLE_MS)
    queue.decide(['b'], 'confirmed')
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(settle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(REVIEW_BATCH_IDLE_MS)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('flushes immediately when the screen goes away', async () => {
    const { queue, send } = harness()
    queue.decide(['a'], 'rejected')
    await queue.flush()
    expect(send).toHaveBeenCalledWith(['a'], 'rejected')
  })
})
