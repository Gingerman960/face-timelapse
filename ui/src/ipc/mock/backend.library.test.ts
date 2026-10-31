import { describe, expect, it } from 'vitest'
import type { DayGroup, PhotoSummary } from '../contract'
import { FakeBackend } from './fakeBackend'
import { EXTRA_NO_FACE_PATH, REFERENCE_PATH, demoLibrary, extraPhotos } from './fixtures'
import { HEIC_REFERENCE_PATH } from './mockFs'
import { expectIpcError as rejects } from './testing'

type Scenario = 'fresh' | 'ready' | 'scanned' | 'reviewed' | 'aligned'
const backend = (scenario: Scenario = 'reviewed') => new FakeBackend({ scenario, speed: 'instant' })
const lib = demoLibrary()
const day = async (b: FakeBackend, key: string): Promise<DayGroup | undefined> =>
  (await b.call('get_days', {})).find((d) => d.dayKey === key)

describe('photos', () => {
  it('lists photos in relPath order, filtered by status', async () => {
    const b = backend('scanned')
    const all = await b.call('get_photos', { query: { statuses: null } })
    expect(all).toHaveLength(3593)
    expect(all.map((p) => p.relPath)).toEqual(lib.byRelPath.map((p) => p.relPath))
    const unsure = await b.call('get_photos', { query: { statuses: ['uncertain'] } })
    expect(unsure).toHaveLength(41)
    expect(unsure.every((p) => p.review === 'pending' && !p.included)).toBe(true)
    expect(unsure[11]?.takenAt).toBe('2017-03-03T21:07:14')
    const noFace = await b.call('get_photos', { query: { statuses: ['noFace', 'failed'] } })
    expect(noFace).toHaveLength(17)
    expect(noFace.every((p) => p.faceBox === null && p.score === 0)).toBe(true)
  })

  it('says when a photo has a real time of day (contract v1.4)', async () => {
    const all = await backend('scanned').call('get_photos', { query: { statuses: null } })
    const known = new Map(lib.photos.map((p) => [p.id, p.timeKnown]))
    expect(all.every((p) => p.timeKnown === known.get(p.id))).toBe(true)
    expect(all.find((p) => p.dayKey === '2022-08-31')).toMatchObject({ timeKnown: false, takenAt: '2022-08-31T00:00:00' })
    expect(all.filter((p) => p.timeKnown).length).toBeGreaterThan(3500)
  })

  it('returns face boxes from the matched face', async () => {
    const [first] = await backend('scanned').call('get_photos', { query: { statuses: ['confirmed'] } })
    const fixture = lib.byId.get(first!.id)!
    expect(first!.faceBox).toEqual(fixture.faces[fixture.matchedFace!]!.bounds)
  })

  it('rejects bad queries and needs a folder', async () => {
    await rejects(backend().call('get_photos', { query: { statuses: ['bogus' as never] } }), 'invalidArgument')
    await rejects(backend().call('get_photos', {} as never), 'invalidArgument')
    await rejects(backend('fresh').call('get_photos', { query: { statuses: null } }), 'notReady', 'Choose a source folder first.')
    expect(await backend('ready').call('get_photos', { query: { statuses: null } })).toEqual([])
  })

  it('returns photo details', async () => {
    const spotlight = lib.photos.find((p) => p.takenAt === '2017-03-03T21:07:14')!
    const detail = await backend('scanned').call('get_photo', { photoId: spotlight.id })
    expect(detail.summary).toMatchObject({ id: spotlight.id, score: 0.47, status: 'uncertain' })
    expect(detail.path).toBe(spotlight.path)
    expect(detail.faces).toHaveLength(2)
    expect(detail.matchedFace).not.toBeNull()
    expect(detail.rawSimilarity).toBeGreaterThan(0.2)
    expect(detail.previewVersion).toMatch(/^[0-9a-f]+$/)
    const faceless = lib.photos.find((p) => p.status === 'noFace')!
    expect((await backend('scanned').call('get_photo', { photoId: faceless.id })).previewVersion).toBeNull()
    await rejects(backend('scanned').call('get_photo', { photoId: '0000000000000000' }), 'notFound')
    await rejects(backend('ready').call('get_photo', { photoId: spotlight.id }), 'notFound')
  })
})

describe('review decisions', () => {
  it('keeps, leaves out and resets uncertain photos', async () => {
    const b = backend('scanned')
    const unsure = await b.call('get_photos', { query: { statuses: ['uncertain'] } })
    const ids = unsure.slice(0, 2).map((p) => p.id)
    let counts = await b.call('set_review_decision', { photoIds: ids, decision: 'confirmed' })
    expect(counts).toMatchObject({ reviewPending: 39, included: 3531, uncertain: 41 })
    counts = await b.call('set_review_decision', { photoIds: ids, decision: 'rejected' })
    expect(counts).toMatchObject({ reviewPending: 39, included: 3529 })
    counts = await b.call('set_review_decision', { photoIds: ids, decision: 'pending' })
    expect(counts.reviewPending).toBe(41)
  })

  it('rescues a rejected photo but never keeps a photo without a face', async () => {
    const b = backend('reviewed')
    const [rejected] = await b.call('get_photos', { query: { statuses: ['rejected'] } })
    const counts = await b.call('set_review_decision', { photoIds: [rejected!.id], decision: 'confirmed' })
    expect(counts.included).toBe(3559)
    const [noFace] = await b.call('get_photos', { query: { statuses: ['noFace'] } })
    await rejects(b.call('set_review_decision', { photoIds: [noFace!.id], decision: 'confirmed' }), 'invalidArgument')
    await rejects(b.call('set_review_decision', { photoIds: ['0000000000000000'], decision: 'rejected' }), 'notFound')
    await rejects(b.call('set_review_decision', { photoIds: [rejected!.id], decision: 'maybe' as never }), 'invalidArgument')
    await rejects(b.call('set_review_decision', { photoIds: 'x' as never, decision: 'pending' }), 'invalidArgument')
  })
})

describe('days', () => {
  it('groups included photos with the auto pick (max score, then earliest)', async () => {
    const days = await backend().call('get_days', {})
    expect(days).toHaveLength(3547)
    expect(days.map((d) => d.dayKey)).toEqual(days.map((d) => d.dayKey).slice().sort())
    const may2 = days.find((d) => d.dayKey === '2014-05-02')!
    const scores = may2.photoIds.map((id) => lib.byId.get(id)!.score)
    expect(scores).toEqual([0.912, 0.874, 0.801])
    expect(may2).toMatchObject({ selectedId: may2.photoIds[0], autoSelectedId: may2.photoIds[0], manualSelection: false, excluded: false })
    expect(days.every((d) => d.photoIds.length > 0)).toBe(true)
    await rejects(backend('fresh').call('get_days', {}), 'notReady')
  })

  it('selects a photo of a day', async () => {
    const b = backend()
    const may2 = (await day(b, '2014-05-02'))!
    const chosen = await b.call('select_day_photo', { dayKey: '2014-05-02', photoId: may2.photoIds[2]! })
    expect(chosen).toMatchObject({ selectedId: may2.photoIds[2], autoSelectedId: may2.photoIds[0], manualSelection: true })
    const back = await b.call('select_day_photo', { dayKey: '2014-05-02', photoId: may2.photoIds[0]! })
    expect(back.manualSelection).toBe(false)
    await rejects(b.call('select_day_photo', { dayKey: '2014-05-03', photoId: may2.photoIds[0]! }), 'invalidArgument')
    await rejects(b.call('select_day_photo', { dayKey: '2014-04-29', photoId: may2.photoIds[0]! }), 'notFound')
    await rejects(b.call('select_day_photo', { dayKey: '2014-05-02', photoId: '0000000000000000' }), 'notFound')
    await rejects(b.call('select_day_photo', { dayKey: '2014-13-01', photoId: may2.photoIds[0]! }), 'invalidArgument')
  })

  it('moves a photo to another day (dateSource manual) and back', async () => {
    const b = backend()
    const may2 = (await day(b, '2014-05-02'))!
    const midnight = may2.photoIds.find((id) => lib.byId.get(id)!.takenAt.endsWith('00:41:12'))!
    const patch = await b.call('move_photo_to_day', { photoId: midnight, dayKey: '2014-05-01' })
    expect(patch.removed).toEqual([])
    expect(patch.upserted.map((d) => d.dayKey)).toEqual(['2014-05-01', '2014-05-02'])
    expect(patch.upserted[0]!.photoIds).toContain(midnight)
    const moved = (await b.call('get_photo', { photoId: midnight })).summary
    expect(moved).toMatchObject({ dayKey: '2014-05-01', dateSource: 'manual', takenAt: '2014-05-02T00:41:12' })
    const back = await b.call('move_photo_to_day', { photoId: midnight, dayKey: '2014-05-02' })
    expect(back.upserted.find((d) => d.dayKey === '2014-05-02')!.photoIds).toHaveLength(3)
    expect((await b.call('get_photo', { photoId: midnight })).summary.dateSource).toBe('exif')
  })

  it('creates and removes days when the only photo moves', async () => {
    const b = backend()
    const may3 = (await day(b, '2014-05-03'))!
    const patch = await b.call('move_photo_to_day', { photoId: may3.selectedId, dayKey: '2014-04-29' })
    expect(patch.removed).toEqual(['2014-05-03'])
    expect(patch.upserted.map((d) => d.dayKey)).toEqual(['2014-04-29'])
    expect((await b.call('get_session', {})).counts.days).toBe(3547)
    await rejects(b.call('move_photo_to_day', { photoId: may3.selectedId, dayKey: '2014-5-3' }), 'invalidArgument')
    await rejects(b.call('move_photo_to_day', { photoId: 'ffffffffffffffff', dayKey: '2014-05-03' }), 'notFound')
  })

  it('excludes and re-includes a day', async () => {
    const b = backend()
    const excluded = await b.call('set_day_excluded', { dayKey: '2014-05-02', excluded: true })
    expect(excluded.excluded).toBe(true)
    expect((await b.call('get_session', {})).counts).toMatchObject({ days: 3547, activeDays: 3546 })
    expect((await b.call('set_day_excluded', { dayKey: '2014-05-02', excluded: false })).excluded).toBe(false)
    await rejects(b.call('set_day_excluded', { dayKey: '2014-04-29', excluded: true }), 'notFound')
    await rejects(b.call('set_day_excluded', { dayKey: '2014-05-02', excluded: 'yes' as never }), 'invalidArgument')
  })

  it('adds photos from the dialog (extras), by path, and handles the error cases', async () => {
    const b = backend()
    const patch = await b.call('add_photo_to_day', { dayKey: '2014-04-29', path: null })
    const extra = extraPhotos()[0]!
    expect(patch?.upserted).toEqual([expect.objectContaining({ dayKey: '2014-04-29', photoIds: [extra.id] })])
    const photos = await b.call('get_photos', { query: { statuses: null } })
    const added = photos.find((p) => p.id === extra.id) as PhotoSummary
    expect(added).toMatchObject({ relPath: extra.path, dateSource: 'manual', review: 'confirmed', included: true, timeKnown: false })
    expect(photos[0]?.id).toBe(extra.id)

    const second = await b.call('add_photo_to_day', { dayKey: '2014-04-29', path: null })
    expect(second?.upserted[0]?.photoIds).toHaveLength(2)
    const moved = await b.call('move_photo_to_day', { photoId: extra.id, dayKey: '2014-04-28' })
    expect(moved.upserted.map((d) => d.dayKey)).toEqual(['2014-04-28', '2014-04-29'])
    const dropped = await b.call('set_review_decision', { photoIds: [extra.id], decision: 'rejected' })
    expect(dropped.total).toBe(3594)

    const rejectedPhoto = lib.photos.find((p) => p.status === 'rejected')!
    const rescued = await b.call('add_photo_to_day', { dayKey: '2014-04-27', path: rejectedPhoto.path })
    expect(rescued?.upserted.find((d) => d.dayKey === '2014-04-27')?.photoIds).toContain(rejectedPhoto.id)

    b.configure({ cancelDialogs: true })
    expect(await b.call('add_photo_to_day', { dayKey: '2014-04-29', path: null })).toBeNull()
    await rejects(b.call('add_photo_to_day', { dayKey: '2014-04-29', path: EXTRA_NO_FACE_PATH }), 'noFaceDetected')
    await rejects(b.call('add_photo_to_day', { dayKey: '2014-04-29', path: HEIC_REFERENCE_PATH }), 'unsupportedFormat')
    await rejects(b.call('add_photo_to_day', { dayKey: '2014-04-29', path: '/Users/demo/gone.jpg' }), 'notFound')
    await rejects(b.call('add_photo_to_day', { dayKey: '2014-04-29', path: '/Users/demo/Pictures/a.txt' }), 'unsupportedFormat')
    await rejects(b.call('add_photo_to_day', { dayKey: '2014-04-29', path: '/Users/demo/Pictures/Reference/IMG_20140816_broken.jpg' }), 'decodeFailed')
    await rejects(b.call('add_photo_to_day', { dayKey: '2014-04-29', path: '/Users/demo/Pictures' }), 'invalidArgument')
    await rejects(b.call('add_photo_to_day', { dayKey: '2014-04-29', path: 'x.jpg' }), 'invalidArgument')
    await rejects(b.call('add_photo_to_day', { dayKey: '2014-04-29', path: REFERENCE_PATH }), 'invalidArgument')
    const noFace = lib.photos.find((p) => p.status === 'noFace')!
    await rejects(b.call('add_photo_to_day', { dayKey: '2014-04-29', path: noFace.path }), 'noFaceDetected')
    await rejects(b.call('add_photo_to_day', { dayKey: '2014-02-30', path: null }), 'invalidArgument')
    await rejects(backend('fresh').call('add_photo_to_day', { dayKey: '2014-04-29', path: null }), 'notReady')
  })
})
