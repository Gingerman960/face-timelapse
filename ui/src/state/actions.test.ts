import { afterEach, describe, expect, it } from 'vitest'
import type { DayGroup, DaysPatch, FramesView, PhotoSummary, SessionSnapshot } from '../ipc/contract'
import { call } from '../ipc/client'
import { installMockBackend, type MockOptions } from '../ipc/mock/install'
import { DEFAULT_MESSAGES } from '../ipc/mock/errors'
import { DEMO_FOLDER, REFERENCE_PATH } from '../ipc/mock/fixtures'
import { resetStores } from '../test/renderApp'
import {
  addPhotoToDay,
  applyDaysPatch,
  clearScanCache,
  movePhotoToDay,
  pickReferencePhoto,
  pickSourceFolder,
  reportError,
  resetSession,
  revealPath,
  selectDayPhoto,
  setDayExcluded,
  setFrameAdjustment,
  setLook,
  setReferenceCrop,
  setReferencePhoto,
  setReferenceRotation,
  setReviewDecision,
  setSourceFolder,
} from './actions'
import { queryClient, queryKeys } from './queries'
import { useView } from './view'

function setup(opts: Partial<MockOptions> = {}) {
  resetStores()
  useView.setState({ toasts: [] })
  return installMockBackend({ scenario: 'aligned', speed: 'instant', ...opts })
}

const cachedSession = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session)
const cachedDays = () => queryClient.getQueryData<DayGroup[]>(queryKeys.days)
const isInvalidated = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated ?? false
const toasts = () => useView.getState().toasts

async function primeSession(): Promise<SessionSnapshot> {
  return queryClient.fetchQuery({ queryKey: queryKeys.session, queryFn: () => call('get_session') })
}

async function primeDays(): Promise<DayGroup[]> {
  return queryClient.fetchQuery({ queryKey: queryKeys.days, queryFn: () => call('get_days') })
}

afterEach(() => {
  delete window.__FT_MOCK__
})

function day(key: string, photoIds: string[] = ['a']): DayGroup {
  return { dayKey: key, photoIds, selectedId: photoIds[0] ?? 'a', manualSelection: false, excluded: false } as DayGroup
}

describe('reportError', () => {
  it('shows the IpcError message as a stop toast and returns it', () => {
    // Arrange
    setup()

    // Act
    const e = reportError({ kind: 'diskFull', message: 'Disk full.' })

    // Assert
    expect(e).toEqual({ kind: 'diskFull', message: 'Disk full.' })
    expect(toasts()).toEqual([expect.objectContaining({ message: 'Disk full.', tone: 'stop' })])
  })

  it('normalizes unknown throws into an internal error', () => {
    // Arrange
    setup()

    // Act
    const e = reportError(new Error('kaput'))

    // Assert
    expect(e).toEqual({ kind: 'internal', message: 'kaput' })
    expect(toasts()[0]?.message).toBe('kaput')
  })
})

// UI review 2, M4: `cancelled` means different things per command (contract v1.3), so it isn't silenced globally.
describe('cancelled, per command', () => {
  it('reportError shows a cancelled error like any other', () => {
    setup()
    reportError({ kind: 'cancelled', message: 'The task was cancelled.' })
    expect(toasts()).toHaveLength(1)
  })

  it('a superseded folder pick resolves null and re-reads the session, with nothing to show', async () => {
    const backend = setup({ scenario: 'ready', fail: { pick_source_folder: 'cancelled' } })
    await primeSession()
    void backend
    await expect(pickSourceFolder()).resolves.toBeNull()
    expect(isInvalidated(queryKeys.session)).toBe(true)
    expect(toasts()).toHaveLength(0)
  })

  it('a photo the folder changed under says so as an info toast and adds nothing', async () => {
    setup({ fail: { add_photo_to_day: 'cancelled' } })
    await primeDays()
    await expect(addPhotoToDay('2014-04-29', null)).resolves.toBeNull()
    expect(toasts()).toEqual([expect.objectContaining({ message: DEFAULT_MESSAGES.cancelled, tone: 'info' })])
  })
})

describe('applyDaysPatch', () => {
  it('removes, replaces and inserts days, keeping dayKey order', () => {
    // Arrange
    const prev = [day('2014-01-01'), day('2014-01-03'), day('2014-01-05')]
    const patch: DaysPatch = { upserted: [day('2014-01-04', ['x']), day('2014-01-03', ['y', 'z']), day('2014-01-02', ['w'])], removed: ['2014-01-05'] }

    // Act
    const next = applyDaysPatch(prev, patch)

    // Assert
    expect(next.map((d) => d.dayKey)).toEqual(['2014-01-01', '2014-01-02', '2014-01-03', '2014-01-04'])
    expect(next.find((d) => d.dayKey === '2014-01-03')?.photoIds).toEqual(['y', 'z'])
    expect(prev.map((d) => d.dayKey)).toEqual(['2014-01-01', '2014-01-03', '2014-01-05'])
  })

  it('returns the same days, in order, for an empty patch', () => {
    // Arrange
    const prev = [day('2014-01-02'), day('2014-01-01'), day('2014-01-02')]

    // Act
    const next = applyDaysPatch(prev, { upserted: [], removed: [] })

    // Assert
    expect(next.map((d) => d.dayKey)).toEqual(['2014-01-01', '2014-01-02'])
  })
})

describe('reference and folder', () => {
  it('a cancelled photo dialog changes nothing', async () => {
    // Arrange
    setup({ scenario: 'fresh', cancelDialogs: true })
    await primeSession()

    // Act
    const picked = await pickReferencePhoto()

    // Assert
    expect(picked).toBeNull()
    expect(cachedSession()?.reference).toBeNull()
    expect(isInvalidated(queryKeys.session)).toBe(false)
  })

  it('a picked photo becomes the reference in the cached session', async () => {
    // Arrange
    setup({ scenario: 'fresh' })
    await primeSession()

    // Act
    const picked = await pickReferencePhoto()

    // Assert
    expect(picked?.image.path).toBe(REFERENCE_PATH)
    expect(cachedSession()?.reference).toEqual(picked)
    expect(isInvalidated(queryKeys.session)).toBe(true)
  })

  it('leaves an uncached session alone when the reference changes', async () => {
    // Arrange
    setup({ scenario: 'fresh' })

    // Act
    const reference = await setReferencePhoto(REFERENCE_PATH)

    // Assert
    expect(reference.image.fileName).toBe('IMG_20140815_142326.jpg')
    expect(cachedSession()).toBeUndefined()
  })

  it('rotation and crop commit through the backend', async () => {
    // Arrange
    setup({ scenario: 'ready' })
    await primeSession()

    // Act
    const rotated = await setReferenceRotation(2)
    const cropped = await setReferenceCrop({ x: 600, y: 0, width: 1800, height: 1800 }, '1:1')

    // Assert
    expect(rotated.image.rotationDeg).toBe(2)
    expect(cropped).toMatchObject({ aspect: '1:1', crop: { width: 1800, height: 1800 } })
    expect(cachedSession()?.reference?.aspect).toBe('1:1')
  })

  it('a cancelled folder dialog returns null; a chosen folder is cached', async () => {
    // Arrange
    const backend = setup({ scenario: 'fresh', cancelDialogs: true })
    await primeSession()

    // Act
    const cancelled = await pickSourceFolder()
    backend.configure({ cancelDialogs: false })
    const picked = await pickSourceFolder()

    // Assert
    expect(cancelled).toBeNull()
    expect(picked?.path).toBe(DEMO_FOLDER)
    expect(cachedSession()?.folder?.path).toBe(DEMO_FOLDER)
  })

  it('setSourceFolder rejects with the backend error', async () => {
    // Arrange
    setup({ scenario: 'fresh' })

    // Act
    const result = setSourceFolder('/Users/demo/Nope')

    // Assert
    await expect(result).rejects.toMatchObject({ kind: 'notFound' })
  })

  it('clearing the scan cache re-reads the session', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    await primeSession()

    // Act
    await clearScanCache('folder')

    // Assert
    expect(isInvalidated(queryKeys.session)).toBe(true)
  })
})

describe('review and days', () => {
  it('a review decision updates the cached counts', async () => {
    // Arrange
    setup({ scenario: 'scanned' })
    const before = (await primeSession()).counts.reviewPending
    const unsure = await call('get_photos', { query: { statuses: ['uncertain'] } })
    const id = (unsure[0] as PhotoSummary).id

    // Act
    const counts = await setReviewDecision([id], 'confirmed')

    // Assert
    expect(counts.reviewPending).toBe(before - 1)
    expect(cachedSession()?.counts).toEqual(counts)
  })

  it('choosing a day photo and leaving a day out replace that day in the cache', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    const days = await primeDays()
    const target = days.find((d) => d.photoIds.length > 1) as DayGroup
    const other = target.photoIds.find((id) => id !== target.selectedId) as string

    // Act
    const picked = await selectDayPhoto(target.dayKey, other)
    const excluded = await setDayExcluded(target.dayKey, true)

    // Assert
    expect(picked.selectedId).toBe(other)
    expect(excluded.excluded).toBe(true)
    expect(cachedDays()?.find((d) => d.dayKey === target.dayKey)).toEqual(excluded)
    expect(cachedDays()).toHaveLength(days.length)
  })

  it('day changes without a cached day list leave the cache empty', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    const days = await call('get_days')
    const target = days[0] as DayGroup

    // Act
    await setDayExcluded(target.dayKey, true)

    // Assert
    expect(cachedDays()).toBeUndefined()
  })

  it('moving a photo patches the cached days', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    const days = await primeDays()
    const from = days.find((d) => d.photoIds.length > 1) as DayGroup
    const to = days.find((d) => d.dayKey > from.dayKey) as DayGroup

    // Act
    const patch = await movePhotoToDay(from.selectedId, to.dayKey)

    // Assert
    expect(patch.upserted.map((d) => d.dayKey)).toContain(to.dayKey)
    expect(cachedDays()?.find((d) => d.dayKey === to.dayKey)?.photoIds).toContain(from.selectedId)
  })

  it('adding a photo from a cancelled dialog returns null; a chosen one patches the days', async () => {
    // Arrange
    const backend = setup({ scenario: 'aligned', cancelDialogs: true })
    const days = await primeDays()
    const target = days[0] as DayGroup

    // Act
    const cancelled = await addPhotoToDay(target.dayKey, null)
    backend.configure({ cancelDialogs: false })
    const patch = await addPhotoToDay(target.dayKey, null)

    // Assert
    expect(cancelled).toBeNull()
    expect(patch?.upserted.some((d) => d.dayKey === target.dayKey)).toBe(true)
    expect(cachedDays()?.find((d) => d.dayKey === target.dayKey)?.photoIds.length).toBeGreaterThan(target.photoIds.length)
  })
})

describe('frames and look', () => {
  it('a nudge replaces just that frame in the cached frames', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    const view = await queryClient.fetchQuery({ queryKey: queryKeys.frames, queryFn: () => call('get_frames') })
    const [first, second] = view.frames
    const adjust = { dx: 0.02, dy: -0.01, scale: 1.05, rotationDeg: 1.5 }

    // The photo's detail is cached (Review reads its preview version from it).
    await queryClient.fetchQuery({ queryKey: queryKeys.photo(first!.photoId), queryFn: () => call('get_photo', { photoId: first!.photoId }) })

    // Act
    await setFrameAdjustment(first!.photoId, adjust)

    // Assert: the preview version follows the nudge (contract v1.7), so the detail is read again.
    expect(isInvalidated(queryKeys.photo(first!.photoId))).toBe(true)
    const after = queryClient.getQueryData<FramesView>(queryKeys.frames)
    expect(after?.frames[0]?.adjust).toEqual(adjust)
    expect(after?.frames[0]?.version).not.toBe(first?.version)
    expect(after?.frames[1]).toEqual(second)
  })

  // UI review 2, H3: a second nudge sent before the first returned carried the old values and undid the first.
  it('overlapping nudges of one frame merge, and an older answer never overwrites a newer edit', async () => {
    // Arrange: the backend answers each nudge after a delay.
    const backend = setup({ scenario: 'aligned' })
    const view = await queryClient.fetchQuery({ queryKey: queryKeys.frames, queryFn: () => call('get_frames') })
    const photoId = view.frames[0]!.photoId
    const handle = backend.handle
    Object.defineProperty(backend, 'handle', {
      value: async (cmd: string, payload?: unknown) => {
        if (cmd === 'set_frame_adjustment') await new Promise((resolve) => setTimeout(resolve, 40))
        return handle(cmd, payload)
      },
    })
    const frame = () => queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames.find((f) => f.photoId === photoId)

    // Act: across, then down, the second sent while the first travels.
    const first = setFrameAdjustment(photoId, { dx: 0.05 })
    expect(frame()?.adjust.dx).toBe(0.05)
    const second = setFrameAdjustment(photoId, { dy: 0.03 })
    await Promise.all([first, second])

    // Assert
    expect(frame()?.adjust).toMatchObject({ dx: 0.05, dy: 0.03 })
  })

  // UI review 3, M1: the rollback went back past a nudge the backend had applied.
  it('a failure after an older nudge succeeded keeps what the backend applied', async () => {
    // Arrange: the first nudge succeeds after 40 ms, the second fails after 120 ms.
    const backend = setup({ scenario: 'aligned' })
    const view = await queryClient.fetchQuery({ queryKey: queryKeys.frames, queryFn: () => call('get_frames') })
    const photoId = view.frames[0]!.photoId
    const handle = backend.handle
    let n = 0
    Object.defineProperty(backend, 'handle', {
      value: async (cmd: string, payload?: unknown) => {
        if (cmd !== 'set_frame_adjustment') return handle(cmd, payload)
        n += 1
        if (n === 1) {
          await new Promise((resolve) => setTimeout(resolve, 40))
          return handle(cmd, payload)
        }
        await new Promise((resolve) => setTimeout(resolve, 120))
        throw { kind: 'internal', message: 'render failed' }
      },
    })

    // Act
    const first = setFrameAdjustment(photoId, { dx: 0.05 })
    const second = setFrameAdjustment(photoId, { dy: 0.03 }).catch(() => undefined)
    await Promise.all([first, second])

    // Assert: the cache agrees with the backend (dx applied), and the frames are re-read to be sure.
    const applied = (await call('get_frames')).frames.find((f) => f.photoId === photoId)
    const cached = queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames.find((f) => f.photoId === photoId)
    expect(applied?.adjust.dx).toBeCloseTo(0.05)
    expect(cached?.adjust.dx).toBeCloseTo(0.05)
    expect(cached?.adjust.dy).toBe(0)
    expect(isInvalidated(queryKeys.frames)).toBe(true)
  })

  it('a failed nudge puts the confirmed frame back', async () => {
    setup({ scenario: 'aligned', fail: { set_frame_adjustment: 'io' } })
    const view = await queryClient.fetchQuery({ queryKey: queryKeys.frames, queryFn: () => call('get_frames') })
    const before = view.frames[0]!
    await expect(setFrameAdjustment(before.photoId, { dx: 0.05 })).rejects.toMatchObject({ kind: 'io' })
    expect(queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames[0]).toEqual(before)
  })

  it('a nudge without cached frames leaves the cache empty', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    const view = await call('get_frames')

    // Act
    await setFrameAdjustment(view.frames[0]!.photoId, { dx: 0.01, dy: 0, scale: 1, rotationDeg: 0 })

    // Assert
    expect(queryClient.getQueryData(queryKeys.frames)).toBeUndefined()
  })

  it('a new look caches the returned frames and the session look', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    await primeSession()
    const look = { normalize: 'exposure' as const, strength: 0.4 }

    // Act
    const view = await setLook(look)

    // Assert
    expect(view.look).toEqual(look)
    expect(queryClient.getQueryData(queryKeys.frames)).toEqual(view)
    expect(cachedSession()?.look).toEqual(look)
  })

  it('setLook rejects with the backend error', async () => {
    // Arrange
    setup({ scenario: 'aligned', fail: { set_look: 'io' } })

    // Act + Assert
    await expect(setLook({ normalize: 'off', strength: 0.7 })).rejects.toEqual({ kind: 'io', message: DEFAULT_MESSAGES.io })
  })
})

describe('revealPath', () => {
  it('toasts when the path is not an export of this session', async () => {
    // Arrange
    setup({ scenario: 'aligned' })

    // Act
    await revealPath('/Users/demo/Movies/not-mine.mp4')

    // Assert
    expect(toasts()).toEqual([expect.objectContaining({ tone: 'stop', message: 'FaceTimelapse can only show files it exported in this session.' })])
  })

  it('toasts the injected backend failure', async () => {
    // Arrange
    setup({ scenario: 'aligned', fail: { reveal_path: 'permissionDenied' } })

    // Act
    await revealPath('/Users/demo/Movies/a.mp4')

    // Assert
    expect(toasts()[0]?.message).toBe(DEFAULT_MESSAGES.permissionDenied)
  })
})

describe('resetSession', () => {
  it('replaces the session and drops the derived day and frame caches', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    await primeSession()
    await primeDays()
    await queryClient.fetchQuery({ queryKey: queryKeys.frames, queryFn: () => call('get_frames') })

    // Act
    await resetSession()

    // Assert
    expect(cachedSession()?.reference).toBeNull()
    expect(cachedSession()?.recents.references.length).toBeGreaterThan(0)
    expect(cachedDays()).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.frames)).toBeUndefined()
  })
})
