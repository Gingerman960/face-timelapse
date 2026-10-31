// UI review 2, H2: an in-flight crop commit cleared any newer draft when it
// resolved, so a drag or nudge made meanwhile snapped back and was lost.
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('../../state/actions', () => ({ setReferenceCrop: vi.fn() }))
import { setReferenceCrop } from '../../state/actions'
import { COMMIT_DELAY_MS, useCropDraft } from './useCropDraft'

const A = { x: 0, y: 0, width: 100, height: 100 }
const B = { x: 1, y: 0, width: 100, height: 100 }

/** Makes the next `setReferenceCrop` wait until the returned function is called. */
function holdNextCommit(): () => void {
  let release: () => void = () => undefined
  vi.mocked(setReferenceCrop).mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({} as never))))
  return () => release()
}

describe('useCropDraft with a commit in flight', () => {
  it('keeps a draft made while an earlier commit travels', async () => {
    // Arrange
    const releaseA = holdNextCommit()
    const { result } = renderHook(() => useCropDraft('free'))
    act(() => void result.current.commit(A, 'free'))

    // Act: a drag while A travels, then A's answer.
    act(() => result.current.setDraft(B))
    await act(async () => releaseA())

    // Assert
    expect(result.current.draft).toEqual(B)
    expect(result.current.latest()).toEqual(B)
  })

  it('keeps a nudge scheduled meanwhile, and commits it after the quiet delay', async () => {
    // Arrange
    vi.useFakeTimers()
    const releaseA = holdNextCommit()
    vi.mocked(setReferenceCrop).mockResolvedValue({} as never)
    const { result } = renderHook(() => useCropDraft('free'))
    act(() => void result.current.commit(A, 'free'))

    // Act
    act(() => result.current.schedule(B))
    await act(async () => releaseA())

    // Assert: B is still on screen and still goes out.
    expect(result.current.draft).toEqual(B)
    await act(async () => vi.advanceTimersByTime(COMMIT_DELAY_MS))
    expect(setReferenceCrop).toHaveBeenLastCalledWith(B, 'free')
    vi.useRealTimers()
  })

  it('clears its own draft once committed, also after a failure', async () => {
    vi.mocked(setReferenceCrop).mockResolvedValueOnce({} as never).mockRejectedValueOnce({ kind: 'io', message: 'x' })
    const { result } = renderHook(() => useCropDraft('free'))
    act(() => result.current.setDraft(A))
    await act(async () => void (await result.current.commit(A, 'free')))
    expect(result.current.draft).toBeNull()
    act(() => result.current.setDraft(B))
    await act(async () => void (await result.current.commit(B, 'free')))
    expect(result.current.draft).toBeNull()
    expect(result.current.error).toMatchObject({ kind: 'io' })
  })
})

// UI review 3, M3: Reset, Centre or an aspect change within 150 ms of a nudge
// cancelled the nudge's commit but left its draft on screen, unsent.
describe('a commit that supersedes a scheduled nudge', () => {
  it('drops the nudge’s draft along with its timer', async () => {
    vi.useFakeTimers()
    vi.mocked(setReferenceCrop).mockReset()
    vi.mocked(setReferenceCrop).mockResolvedValue({} as never)
    const { result } = renderHook(() => useCropDraft('free'))

    act(() => result.current.schedule(B))
    await act(async () => void (await result.current.commit(A, 'free')))
    await act(async () => vi.advanceTimersByTime(COMMIT_DELAY_MS * 4))
    vi.useRealTimers()

    expect(vi.mocked(setReferenceCrop).mock.calls.map(([rect]) => rect)).toEqual([A])
    expect(result.current.draft).toBeNull()
    expect(result.current.latest()).toBeNull()
  })
})
