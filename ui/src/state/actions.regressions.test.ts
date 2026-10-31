// Regressions from UI review #1 (H1, H2, M4): caches that must follow the
// backend after day edits, folder changes and reference changes.
import { afterEach, describe, expect, it } from 'vitest'
import type { DayGroup, PhotoSummary, SessionSnapshot } from '../ipc/contract'
import { call } from '../ipc/client'
import { installMockBackend, type MockOptions } from '../ipc/mock/install'
import { EMPTY_FOLDER } from '../ipc/mock/mockFs'
import { RESTORED_CROP } from '../ipc/mock/fixtures'
import { resetStores } from '../test/renderApp'
import {
  addPhotoToDay,
  clearScanCache,
  movePhotoToDay,
  selectDayPhoto,
  setDayExcluded,
  setReferenceCrop,
  setReviewDecision,
  setSourceFolder,
} from './actions'
import { queryClient, queryKeys, refreshAll, sessionChangedByBackend } from './queries'
import { useView } from './view'

function setup(opts: Partial<MockOptions> = {}) {
  resetStores()
  return installMockBackend({ scenario: 'aligned', speed: 'instant', ...opts })
}

afterEach(() => {
  delete window.__FT_MOCK__
})

const isInvalidated = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated ?? false

async function primeAll(): Promise<{ days: DayGroup[]; photos: PhotoSummary[] }> {
  await queryClient.fetchQuery({ queryKey: queryKeys.session, queryFn: () => call('get_session') })
  const days = await queryClient.fetchQuery({ queryKey: queryKeys.days, queryFn: () => call('get_days') })
  const photos = await queryClient.fetchQuery({ queryKey: queryKeys.photos(null), queryFn: () => call('get_photos', { query: { statuses: null } }) })
  await queryClient.fetchQuery({ queryKey: queryKeys.frames, queryFn: () => call('get_frames') })
  const first = photos[0] as PhotoSummary
  await queryClient.fetchQuery({ queryKey: queryKeys.photo(first.id), queryFn: () => call('get_photo', { photoId: first.id }) })
  return { days, photos }
}

describe('H1: every change to the day pool refreshes the frames', () => {
  it('leaving a day out (e.g. from the Timelapse inspector) invalidates frames, days, photos and the session', async () => {
    setup()
    const { days } = await primeAll()
    await setDayExcluded((days[0] as DayGroup).dayKey, true)
    expect(isInvalidated(queryKeys.frames)).toBe(true)
    expect(isInvalidated(queryKeys.session)).toBe(true)
    expect(isInvalidated(queryKeys.photos(null))).toBe(true)
  })

  it('choosing another photo for a day invalidates frames', async () => {
    setup()
    const { days } = await primeAll()
    const day = days.find((d) => d.photoIds.length > 1) as DayGroup
    await selectDayPhoto(day.dayKey, day.photoIds.find((id) => id !== day.selectedId) as string)
    expect(isInvalidated(queryKeys.frames)).toBe(true)
  })

  it('moving or adding a photo invalidates frames', async () => {
    setup()
    const { days } = await primeAll()
    const from = days.find((d) => d.photoIds.length > 1) as DayGroup
    const to = days.find((d) => d.dayKey > from.dayKey) as DayGroup
    await movePhotoToDay(from.selectedId, to.dayKey)
    expect(isInvalidated(queryKeys.frames)).toBe(true)
    await queryClient.fetchQuery({ queryKey: queryKeys.frames, queryFn: () => call('get_frames') })
    await addPhotoToDay(to.dayKey, null)
    expect(isInvalidated(queryKeys.frames)).toBe(true)
  })

  it('a review decision invalidates frames', async () => {
    setup({ scenario: 'reviewed' })
    await primeAll()
    const unsure = await call('get_photos', { query: { statuses: ['uncertain'] } })
    await setReviewDecision([(unsure[0] as PhotoSummary).id], 'rejected')
    expect(isInvalidated(queryKeys.frames)).toBe(true)
  })
})

describe('H2: a new folder never shows the previous folder’s data', () => {
  it('drops the library, days, frames and photo details, and resets day and review state', async () => {
    setup()
    await primeAll()
    useView.setState({ activeDay: '2014-05-02', reviewIndex: 7, reviewUndo: [{ ids: ['x'], previous: 'pending' }], daysYear: 2014 })

    await setSourceFolder(EMPTY_FOLDER)

    expect(queryClient.getQueryData(queryKeys.photos(null))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.days)).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.frames)).toBeUndefined()
    expect(queryClient.getQueriesData({ queryKey: ['photo'] }).filter(([, d]) => d !== undefined)).toEqual([])
    expect(useView.getState()).toMatchObject({ activeDay: null, reviewIndex: 0, reviewUndo: [], daysYear: null })
    expect(isInvalidated(queryKeys.session)).toBe(true)
  })

  it('forgetting the scan cache drops the derived library data too', async () => {
    setup()
    await primeAll()
    await clearScanCache('folder')
    expect(queryClient.getQueryData(queryKeys.photos(null))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.days)).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.frames)).toBeUndefined()
  })
})

describe('M4: photo details follow the reference', () => {
  it('a reference change invalidates every cached photo detail (matched face changes)', async () => {
    setup()
    const { photos } = await primeAll()
    const id = (photos[0] as PhotoSummary).id
    const session = queryClient.getQueryData<SessionSnapshot>(queryKeys.session)
    await setReferenceCrop({ ...RESTORED_CROP, x: RESTORED_CROP.x + 10 }, session?.reference?.aspect ?? '3:4')
    expect(isInvalidated(queryKeys.photo(id))).toBe(true)
  })

  it('refreshAll (after a job) invalidates photo details', async () => {
    setup()
    const { photos } = await primeAll()
    await refreshAll()
    expect(isInvalidated(queryKeys.photo((photos[0] as PhotoSummary).id))).toBe(true)
  })
})

describe('v1.2 session-changed', () => {
  it('drops every derived cache and re-reads the session', async () => {
    setup()
    await primeAll()
    sessionChangedByBackend()
    expect(queryClient.getQueryData(queryKeys.photos(null))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.days)).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.frames)).toBeUndefined()
    expect(isInvalidated(queryKeys.session)).toBe(true)
  })
})
