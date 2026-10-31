import { describe, expect, it } from 'vitest'
import type { FrameAdjust } from '../contract'
import { FakeBackend } from './fakeBackend'
import { residualFor } from './frames'
import type { MockOptions } from './options'
import { expectIpcError as rejects } from './testing'
import { decodeFrameVersion } from './versions'

const backend = (scenario: MockOptions['scenario'] = 'aligned', extra: Partial<MockOptions> = {}) =>
  new FakeBackend({ scenario, speed: 'instant', ...extra })
const identity: FrameAdjust = { dx: 0, dy: 0, scale: 1, rotationDeg: 0 }

describe('frames view', () => {
  it('lists every active day chronologically with output-space reference anchors', async () => {
    const view = await backend().call('get_frames', {})
    expect(view.status).toBe('complete')
    expect(view.outputSize).toEqual({ width: 1080, height: 1440 })
    expect(view.render).toEqual({ resolution: '1080p', backdrop: 'extended', refineLandmarks: true })
    expect(view.look).toEqual({ normalize: 'off', strength: 0.7 })
    expect(view.referenceAnchors).toEqual([
      { x: 0.3834, y: 0.4286 },
      { x: 0.6517, y: 0.4286 },
      { x: 0.5065, y: 0.5571 },
      { x: 0.4036, y: 0.667 },
      { x: 0.6344, y: 0.667 },
    ])
    expect(view.frames).toHaveLength(3547)
    const keys = view.frames.map((f) => f.dayKey)
    expect(keys).toEqual(keys.slice().sort())
    expect(view.frames[713]?.dayKey).toBe('2014-08-30')
    expect(view.frames.every((f) => f.lookDelta === null)).toBe(true)
  })

  it('carries the photo’s timeKnown into its frame (contract v1.4)', async () => {
    const { frames } = await backend().call('get_frames', {})
    expect(frames.at(-1)).toMatchObject({ dayKey: '2022-08-31', takenAt: '2022-08-31T00:00:00', timeKnown: false })
    expect(frames.filter((f) => f.timeKnown).length).toBeGreaterThan(frames.length * 0.97)
  })

  it('has residual outliers (> 3× median) for about 2 % of frames and a few nudged frames', async () => {
    const { frames } = await backend().call('get_frames', {})
    const residuals = frames.map((f) => f.residualPx).sort((a, b) => a - b)
    const median = residuals[Math.floor(residuals.length / 2)]!
    const outliers = residuals.filter((r) => r > 3 * median).length / residuals.length
    expect(outliers).toBeGreaterThan(0.01)
    expect(outliers).toBeLessThan(0.03)
    const nudged = frames.filter((f) => JSON.stringify(f.adjust) !== JSON.stringify(identity))
    expect(nudged).toHaveLength(12)
    expect(residualFor(frames[0]!.photoId)).toBe(frames[0]!.residualPx)
  })

  it('is empty before alignment and stale after the crop changes', async () => {
    const view = await backend('reviewed').call('get_frames', {})
    expect(view).toMatchObject({ status: 'none', frames: [] })
    expect((await backend('fresh').call('get_frames', {})).referenceAnchors).toBeNull()
    const b = backend()
    await b.call('set_reference_crop', { crop: { x: 700, y: 0, width: 1776, height: 2368 }, aspect: '3:4' })
    const stale = await b.call('get_frames', {})
    expect(stale.status).toBe('stale')
    expect(stale.frames).toEqual([])
    expect((await b.call('get_session', {})).frames).toMatchObject({ status: 'stale', count: 0, expected: 3547 })
    await b.call('set_reference_crop', { crop: { x: 746, y: 0, width: 1664, height: 2219 }, aspect: '3:4' })
    expect((await b.call('get_frames', {})).status).toBe('complete')
  })

  it('becomes partial when a day gets a new photo', async () => {
    const b = backend()
    const may2 = (await b.call('get_days', {})).find((d) => d.dayKey === '2014-05-02')!
    await b.call('select_day_photo', { dayKey: '2014-05-02', photoId: may2.photoIds[1]! })
    expect((await b.call('get_session', {})).frames).toMatchObject({ status: 'partial', count: 3546, expected: 3547 })
  })
})

describe('look', () => {
  it('fills lookDelta when the look is on and changes frame versions', async () => {
    const b = backend()
    const before = await b.call('get_frames', {})
    const view = await b.call('set_look', { look: { normalize: 'exposureAndColor', strength: 1 } })
    expect(view.look).toEqual({ normalize: 'exposureAndColor', strength: 1 })
    expect(view.frames[0]!.version).not.toBe(before.frames[0]!.version)
    const deltas = view.frames.map((f) => f.lookDelta!)
    expect(deltas.every((d) => Math.abs(d.exposureEv) <= 1.5 && d.colorShift >= 0 && d.colorShift <= 6)).toBe(true)
    expect(deltas.some((d) => d.colorShift > 2)).toBe(true)
    const exposure = await b.call('set_look', { look: { normalize: 'exposure', strength: 0.5 } })
    expect(exposure.frames.every((f) => f.lookDelta?.colorShift === 0)).toBe(true)
    expect(decodeFrameVersion(exposure.frames[0]!.version)?.look).toEqual({ normalize: 'exposure', strength: 0.5 })
    expect((await b.call('get_session', {})).look.normalize).toBe('exposure')
  })

  it('validates the look', async () => {
    await rejects(backend().call('set_look', { look: { normalize: 'exposure', strength: 1.5 } }), 'invalidArgument')
    await rejects(backend().call('set_look', { look: { normalize: 'auto' as never, strength: 1 } }), 'invalidArgument')
  })
})

describe('video settings (v1.5)', () => {
  it('saves the settings without an export', async () => {
    const b = backend()
    const settings = { ...b.current.video, pace: { mode: 'fps' as const, fps: 24 }, crossfade: { frames: 2, easing: 'linear' as const } }
    await expect(b.call('set_video_settings', { settings })).resolves.toEqual(settings)
    expect(b.current.video).toEqual(settings)
    expect((await b.call('get_session', {})).video).toEqual(settings)
  })

  it('rejects settings the export would reject', async () => {
    const b = backend()
    const caption = { position: 'bottomLeft' as const, size: 0.04, format: '%Q' }
    await rejects(b.call('set_video_settings', { settings: { ...b.current.video, caption } }), 'invalidArgument')
    await rejects(b.call('set_video_settings', { settings: { ...b.current.video, holdLastSecs: 99 } }), 'invalidArgument')
  })
})

describe('frame adjustment', () => {
  it('re-renders one frame with the adjust and remembers it', async () => {
    const b = backend()
    const [first] = (await b.call('get_frames', {})).frames
    const adjust = { dx: 0.02, dy: -0.01, scale: 1.05, rotationDeg: 2 }
    const updated = await b.call('set_frame_adjustment', { photoId: first!.photoId, adjust })
    expect(updated).toMatchObject({ photoId: first!.photoId, dayKey: first!.dayKey, adjust })
    expect(updated.version).not.toBe(first!.version)
    expect(decodeFrameVersion(updated.version)?.adjust).toEqual(adjust)
    const view = await b.call('get_frames', {})
    expect(view.status).toBe('complete')
    expect(view.frames[0]).toEqual(updated)
    const reset = await b.call('set_frame_adjustment', { photoId: first!.photoId, adjust: identity })
    expect(reset.adjust).toEqual(identity)
  })

  it.each([
    [{ dx: 0.3, dy: 0, scale: 1, rotationDeg: 0 }],
    [{ dx: 0, dy: 0, scale: 2.5, rotationDeg: 0 }],
    [{ dx: 0, dy: 0, scale: 1, rotationDeg: 25 }],
  ])('rejects out-of-range adjusts %j', async (adjust) => {
    const b = backend()
    const [first] = (await b.call('get_frames', {})).frames
    await rejects(b.call('set_frame_adjustment', { photoId: first!.photoId, adjust }), 'invalidArgument')
  })

  it('needs an existing frame', async () => {
    await rejects(backend('reviewed').call('set_frame_adjustment', { photoId: 'ffffffffffffffff', adjust: identity }), 'notFound')
  })
})

describe('export dialogs and reveal', () => {
  it('returns canned paths or null when cancelled', async () => {
    const b = backend()
    expect(await b.call('pick_export_folder', {})).toBe('/Users/demo/Pictures/Timelapse frames')
    expect(await b.call('pick_video_path', { suggestedName: 'FaceTimelapse 2012–2022.mp4' })).toBe(
      '/Users/demo/Movies/FaceTimelapse 2012–2022.mp4',
    )
    expect(await b.call('pick_video_path', { suggestedName: 'a/b' })).toBe('/Users/demo/Movies/a-b.mp4')
    expect(await b.call('pick_video_path', { suggestedName: '' })).toBe('/Users/demo/Movies/FaceTimelapse.mp4')
    await rejects(b.call('pick_video_path', {} as never), 'invalidArgument')
    const cancelled = backend('aligned', { cancelDialogs: true })
    expect(await cancelled.call('pick_export_folder', {})).toBeNull()
    expect(await cancelled.call('pick_video_path', { suggestedName: 'x' })).toBeNull()
  })

  it('only reveals outputs written in this session', async () => {
    const b = backend()
    await rejects(b.call('reveal_path', { path: '/Users/demo/Movies/old.mp4' }), 'invalidArgument')
    await rejects(b.call('reveal_path', { path: 'relative.mp4' }), 'invalidArgument')
  })
})
