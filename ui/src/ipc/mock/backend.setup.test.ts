import { describe, expect, it, vi } from 'vitest'
import type { Rect } from '../contract'
import { FakeBackend } from './fakeBackend'
import {
  DEMO_FOLDER,
  EXTRA_NO_FACE_PATH,
  NO_FACE_REFERENCE_PATH,
  REFERENCE_PATH,
  RESTORED_CROP,
} from './fixtures'
import { rotatePoint } from './geometry'
import { expectIpcError as rejects } from './testing'
import { BROKEN_REFERENCE_PATH, EMPTY_FOLDER, HEIC_REFERENCE_PATH, LOCKED_FOLDER } from './mockFs'

const backend = (scenario: 'fresh' | 'ready' | 'scanned' | 'reviewed' | 'aligned' = 'fresh') =>
  new FakeBackend({ scenario, speed: 'instant' })
const centreOf = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })


describe('app and session', () => {
  it('reports app info with the mock image base', async () => {
    const info = await backend().call('get_app_info', {})
    expect(info).toMatchObject({ imageBaseUrl: '/__mock/img/', platform: 'macos', modelsReady: true, parallelism: 12 })
  })

  it('starts empty in the fresh scenario with ARCHITECTURE defaults', async () => {
    const s = await backend().call('get_session', {})
    expect(s.reference).toBeNull()
    expect(s.folder).toBeNull()
    expect(s.scan).toEqual({ status: 'none', lastSummary: null, scannedAt: null })
    expect(s.render).toEqual({ resolution: '1080p', backdrop: 'extended', refineLandmarks: true })
    expect(s.look).toEqual({ normalize: 'off', strength: 0.7 })
    expect(s.imageExport).toEqual({ format: 'png', jpegQuality: 95, overwrite: false })
    expect(s.video).toEqual({
      pace: { mode: 'fps', fps: 10 },
      resolution: 'source',
      quality: 'high',
      crossfade: { frames: 0, easing: 'easeInOut' },
      caption: null,
      holdFirstSecs: 0,
      holdLastSecs: 1,
    })
    expect(s.activeJob).toBeNull()
    expect(s.recents).toEqual({ references: [], folders: [] })
  })

  it('resets the session but keeps recents and caches', async () => {
    const b = backend('aligned')
    const s = await b.call('reset_session', {})
    expect(s.reference).toBeNull()
    expect(s.folder).toBeNull()
    expect(s.counts.total).toBe(0)
    expect(s.recents.folders).toEqual([DEMO_FOLDER])
    const folder = await b.call('set_source_folder', { path: DEMO_FOLDER })
    expect(folder.analyzedCount).toBe(3593)
    expect((await b.call('get_session', {})).scan.status).toBe('none')
  })

  it('resolves window/plugin commands to null and rejects unknown commands', async () => {
    const b = backend()
    await expect(b.handle('plugin:window|show', {})).resolves.toBeNull()
    await expect(b.handle('plugin:webview|internal_toggle_devtools')).resolves.toBeNull()
    await rejects(b.handle('launch_rockets', {}), 'internal')
  })

  it('injects failures per command and can be reconfigured', async () => {
    const b = new FakeBackend({ scenario: 'ready', speed: 'instant', fail: { get_session: 'io' } })
    await rejects(b.call('get_session', {}), 'io', /Try again/)
    b.configure({ fail: {} })
    await expect(b.call('get_session', {})).resolves.toBeTruthy()
    b.configure({ cancelDialogs: true })
    expect(b.settings.cancelDialogs).toBe(true)
    expect(b.settings.fail).toEqual({})
  })

  it('reloads a scenario', async () => {
    const b = backend('fresh')
    b.loadScenario('scanned')
    expect((await b.call('get_session', {})).counts.reviewPending).toBe(41)
    expect(b.settings.scenario).toBe('scanned')
  })

  it('turns unexpected exceptions into internal errors', async () => {
    const b = backend()
    // A Proxy that throws on access simulates a bug inside a handler.
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom')
        },
      },
    )
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await rejects(b.handle('set_reference_photo', hostile), 'internal')
    expect(spy).toHaveBeenCalled()
  })
})

describe('reference photo', () => {
  it('sets a reference with the whole image as the default free crop', async () => {
    const b = backend()
    const ref = await b.call('set_reference_photo', { path: REFERENCE_PATH })
    expect(ref.image).toMatchObject({
      path: REFERENCE_PATH,
      fileName: 'IMG_20140815_142326.jpg',
      rotationDeg: 0,
      autoRotationDeg: -0.2,
      size: { width: 3200, height: 2368 },
    })
    expect(ref.crop).toEqual({ x: 0, y: 0, width: 3200, height: 2368 })
    expect(ref.aspect).toBe('free')
    expect(ref.detection?.anchors).toHaveLength(5)
    expect(ref.version).toMatch(/^[0-9a-f]+$/)
    expect((await b.call('get_session', {})).recents.references).toEqual([REFERENCE_PATH])
  })

  it('picks the canned reference, or null when the dialog is cancelled', async () => {
    const b = backend()
    expect((await b.call('pick_reference_photo', {}))?.image.path).toBe(REFERENCE_PATH)
    b.configure({ cancelDialogs: true })
    expect(await b.call('pick_reference_photo', {})).toBeNull()
  })

  it('reports a reference without a face inline (detection null)', async () => {
    const ref = await backend().call('set_reference_photo', { path: NO_FACE_REFERENCE_PATH })
    expect(ref.image.face).toBeNull()
    expect(ref.image.autoRotationDeg).toBeNull()
    expect(ref.detection).toBeNull()
  })

  it.each([
    ['relative/IMG.jpg', 'invalidArgument'],
    ['/Users/demo/Pictures/Reference/missing.jpg', 'notFound'],
    [HEIC_REFERENCE_PATH, 'unsupportedFormat'],
    ['/Users/demo/Pictures/notes.txt', 'unsupportedFormat'],
    [BROKEN_REFERENCE_PATH, 'decodeFailed'],
    [DEMO_FOLDER, 'invalidArgument'],
  ] as const)('rejects %s with %s', async (path, kind) => {
    await rejects(backend().call('set_reference_photo', { path }), kind)
  })

  it('uses friendly messages', async () => {
    await rejects(backend().call('set_reference_photo', { path: HEIC_REFERENCE_PATH }), 'unsupportedFormat', /HEIC/)
    await rejects(
      backend().call('set_reference_photo', { path: '/Users/demo/x.jpg' }),
      'notFound',
      'This file is no longer there: /Users/demo/x.jpg',
    )
    await rejects(backend().call('set_reference_photo', { path: 7 } as never), 'invalidArgument')
  })

  it('rotates, carrying the crop through the rotation (reference::rotate_crop), and validates the angle', async () => {
    const b = backend('ready')
    const before = (await b.call('get_session', {})).reference!
    const ref = await b.call('set_reference_rotation', { rotationDeg: 5 })
    expect(ref.image.rotationDeg).toBe(5)
    expect(ref.image.size.width).toBeGreaterThan(3200)
    // The bigger canvas holds the crop, so it keeps its size and aspect…
    expect(ref.aspect).toBe('3:4')
    expect(ref.crop.width).toBeCloseTo(before.crop.width, 6)
    expect(ref.crop.height).toBeCloseTo(before.crop.height, 6)
    // …and its centre turns with the photo about the canvas centres, so the face stays in it.
    const centre = rotatePoint(centreOf(before.crop), before.image.size, ref.image.size, 5)
    expect(centreOf(ref.crop).x).toBeCloseTo(centre.x, 6)
    expect(centreOf(ref.crop).y).toBeCloseTo(centre.y, 6)
    expect(ref.detection).not.toBeNull()
    // Absolute (relative to the EXIF-oriented photo), so rotating doesn't change it.
    expect(ref.image.autoRotationDeg).toBeCloseTo(-0.2, 5)
    // Rotating back returns the crop it started from.
    const back = await b.call('set_reference_rotation', { rotationDeg: 0 })
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(back.crop[k]).toBeCloseTo(before.crop[k], 6)
    await rejects(b.call('set_reference_rotation', { rotationDeg: 46 }), 'invalidArgument')
    await rejects(backend().call('set_reference_rotation', { rotationDeg: 1 }), 'notReady', /reference/)
  })

  it('shrinks a crop the rotated canvas can no longer hold, keeping a fixed aspect, inside the canvas', async () => {
    const b = backend('ready')
    await b.call('set_reference_rotation', { rotationDeg: 30 })
    await b.call('set_reference_crop', { crop: { x: 400, y: 300, width: 3000, height: 3000 }, aspect: '1:1' })
    const square = await b.call('set_reference_rotation', { rotationDeg: 0 })
    expect(square.crop).toEqual({ x: expect.any(Number), y: 0, width: 2368, height: 2368 })
    expect(square.crop.x).toBeGreaterThanOrEqual(0)
    expect(square.crop.x + square.crop.width).toBeLessThanOrEqual(3200)

    await b.call('set_reference_rotation', { rotationDeg: 30 })
    await b.call('set_reference_crop', { crop: { x: 0, y: 0, width: 3900, height: 1000 }, aspect: 'free' })
    const free = await b.call('set_reference_rotation', { rotationDeg: 0 })
    expect(free.crop.width).toBe(3200)
    expect(free.crop.height).toBeCloseTo(1000, 6)
    expect(free.crop.x).toBe(0)
    expect(free.crop.y).toBeGreaterThanOrEqual(0)
  })

  it('crops, detects the face, and goes inline "no face" when the crop excludes it', async () => {
    const b = backend('ready')
    const square: Rect = { x: 416, y: 0, width: 2368, height: 2368 }
    const ref = await b.call('set_reference_crop', { crop: square, aspect: '1:1' })
    expect(ref.crop).toEqual(square)
    expect(ref.detection).not.toBeNull()
    const corner = await b.call('set_reference_crop', { crop: { x: 0, y: 0, width: 400, height: 500 }, aspect: '4:5' })
    expect(corner.detection).toBeNull()
    expect((await b.call('get_session', {})).reference?.aspect).toBe('4:5')
  })

  it('validates crops: bounds (1 px tolerance), minimum size and aspect', async () => {
    const b = backend('ready')
    const ok = await b.call('set_reference_crop', { crop: { x: -1, y: 0, width: 3201, height: 2368 }, aspect: 'free' })
    expect(ok.crop.x).toBe(0)
    await rejects(b.call('set_reference_crop', { crop: { x: -5, y: 0, width: 100, height: 100 }, aspect: 'free' }), 'invalidArgument')
    await rejects(b.call('set_reference_crop', { crop: { x: 0, y: 0, width: 20, height: 20 }, aspect: 'free' }), 'invalidArgument')
    await rejects(b.call('set_reference_crop', { crop: RESTORED_CROP, aspect: '1:1' }), 'invalidArgument', /1:1/)
    await rejects(b.call('set_reference_crop', { crop: RESTORED_CROP, aspect: '2:3' as never }), 'invalidArgument')
    await rejects(backend().call('set_reference_crop', { crop: RESTORED_CROP, aspect: '3:4' }), 'notReady')
  })
})

describe('source folder and cache', () => {
  it('sets the demo folder', async () => {
    const b = backend()
    const info = await b.call('set_source_folder', { path: `${DEMO_FOLDER}/` })
    expect(info).toEqual({ path: DEMO_FOLDER, name: 'Daily selfies', imageCount: 3593, analyzedCount: 0, unsupportedCount: 2 })
    expect((await b.call('pick_source_folder', {}))?.path).toBe(DEMO_FOLDER)
    b.configure({ cancelDialogs: true })
    expect(await b.call('pick_source_folder', {})).toBeNull()
  })

  it('treats other folders as empty and keeps per-folder state', async () => {
    const b = backend('scanned')
    const empty = await b.call('set_source_folder', { path: EMPTY_FOLDER })
    expect(empty).toMatchObject({ name: 'Empty folder', imageCount: 0 })
    expect((await b.call('get_session', {})).scan.status).toBe('none')
    await b.call('set_source_folder', { path: DEMO_FOLDER })
    expect((await b.call('get_session', {})).counts.reviewPending).toBe(41)
  })

  it.each([
    [LOCKED_FOLDER, 'permissionDenied'],
    ['/Users/demo/Nope', 'notFound'],
    [REFERENCE_PATH, 'invalidArgument'],
    ['Pictures', 'invalidArgument'],
  ] as const)('rejects %s with %s', async (path, kind) => {
    await rejects(backend().call('set_source_folder', { path }), kind)
  })

  it('clears the analysis cache of the folder or of all folders', async () => {
    const b = backend('scanned')
    const cleared = await b.call('clear_scan_cache', { scope: 'folder' })
    expect(cleared.removedEntries).toBe(3593)
    expect(cleared.freedBytes).toBeGreaterThan(90_000_000)
    const s = await b.call('get_session', {})
    expect(s.folder?.analyzedCount).toBe(0)
    expect(s.scan.status).toBe('none')
    expect(await b.call('clear_scan_cache', { scope: 'all' })).toEqual({ removedEntries: 0, freedBytes: 0 })
    expect(await backend().call('clear_scan_cache', { scope: 'folder' })).toEqual({ removedEntries: 0, freedBytes: 0 })
    await rejects(b.call('clear_scan_cache', { scope: 'everything' as never }), 'invalidArgument')
  })

  it('knows the add-photo canned paths', async () => {
    const b = backend('reviewed')
    await rejects(b.call('add_photo_to_day', { dayKey: '2014-05-03', path: EXTRA_NO_FACE_PATH }), 'noFaceDetected', /Sunset_no_face\.jpg/)
  })
})
