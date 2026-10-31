// Regression from UI review #1 (H7, state side): look changes can resolve out
// of order; the newest request must win, and the session's look must be the
// one the backend applied (from the response), not the one requested.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FramesView, LookSettings, SessionSnapshot } from '../ipc/contract'
import { makeFrames, makeSession } from '../test/session'

const pending: Array<(view: FramesView) => void> = []

vi.mock('../ipc/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc/client')>()
  return {
    ...actual,
    call: vi.fn(() => new Promise<FramesView>((resolve) => pending.push(resolve))),
  }
})

const { setLook } = await import('./actions')
const { queryClient, queryKeys } = await import('./queries')

function viewWith(look: LookSettings): FramesView {
  return {
    status: 'complete',
    outputSize: { width: 1080, height: 1440 },
    render: { resolution: '1080p', backdrop: 'extended', refineLandmarks: true },
    look,
    referenceAnchors: null,
    frames: makeFrames(3),
  }
}

afterEach(() => {
  pending.length = 0
  queryClient.clear()
})

describe('setLook ordering (H7)', () => {
  it('keeps the newest look when an older response arrives last', async () => {
    // Arrange
    queryClient.setQueryData<SessionSnapshot>(queryKeys.session, makeSession('aligned'))
    const older: LookSettings = { normalize: 'exposure', strength: 0.3 }
    const newer: LookSettings = { normalize: 'exposure', strength: 0.6 }

    // Act
    const first = setLook(older)
    const second = setLook(newer)
    pending[1]?.(viewWith(newer))
    await second
    pending[0]?.(viewWith(older))
    await first

    // Assert
    expect(queryClient.getQueryData<FramesView>(queryKeys.frames)?.look).toEqual(newer)
    expect(queryClient.getQueryData<SessionSnapshot>(queryKeys.session)?.look).toEqual(newer)
  })

  it('stores the look the backend applied, not the one requested', async () => {
    queryClient.setQueryData<SessionSnapshot>(queryKeys.session, makeSession('aligned'))
    const asked: LookSettings = { normalize: 'exposureAndColor', strength: 1.7 }
    const applied: LookSettings = { normalize: 'exposureAndColor', strength: 1 }
    const done = setLook(asked)
    pending[0]?.(viewWith(applied))
    await done
    expect(queryClient.getQueryData<SessionSnapshot>(queryKeys.session)?.look).toEqual(applied)
  })
})

// UI review 2, L3: when the newest request failed after an older one landed, the caches kept a look the backend didn't have.
describe('setLook when the newest request fails', () => {
  it('re-reads the frames and the session', async () => {
    // Arrange
    const { call } = await import('../ipc/client')
    queryClient.setQueryData<SessionSnapshot>(queryKeys.session, makeSession('aligned'))
    queryClient.setQueryData<FramesView>(queryKeys.frames, viewWith({ normalize: 'off', strength: 0.7 }))
    const older = setLook({ normalize: 'exposure', strength: 0.7 })
    vi.mocked(call).mockImplementationOnce(() => Promise.reject({ kind: 'io', message: 'x' }))
    const newest = setLook({ normalize: 'off', strength: 0.7 })

    // Act
    await expect(newest).rejects.toMatchObject({ kind: 'io' })
    pending[0]?.(viewWith({ normalize: 'exposure', strength: 0.7 }))
    await older

    // Assert
    expect(queryClient.getQueryState(queryKeys.frames)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.session)?.isInvalidated).toBe(true)
  })
})
