import { describe, expect, it, vi } from 'vitest'
import type { AlignEvent, ExportImagesEvent, ExportVideoEvent, RenderSettings, ScanEvent } from '../contract'
import { FakeBackend } from './fakeBackend'
import { DEMO_FOLDER, NO_FACE_REFERENCE_PATH, REFERENCE_PATH, demoLibrary } from './fixtures'
import { TICK_MS, chunkBoundaries, jobTiming } from './jobs'
import type { MockOptions } from './options'
import { type JobEventLike, expectIpcError as rejects, recordJob } from './testing'

const render: RenderSettings = { resolution: '1080p', backdrop: 'extended', refineLandmarks: true }
const backend = (scenario: MockOptions['scenario'], extra: Partial<MockOptions> = {}) =>
  new FakeBackend({ scenario, speed: 'instant', ...extra })

function expectLifecycle(events: readonly JobEventLike[], terminal: string) {
  expect(events[0]?.type).toBe('started')
  expect(events.at(-1)?.type).toBe(terminal)
  expect(events.slice(1, -1).every((e) => e.type === 'progress')).toBe(true)
  expect(events.filter((e) => ['finished', 'failed', 'cancelled'].includes(e.type))).toHaveLength(1)
}

describe('timing', () => {
  it('matches the requested speeds', () => {
    expect(jobTiming('scan', 'instant')).toEqual({ steps: 4, tickMs: 0 })
    expect(jobTiming('scan', 'fast').steps * TICK_MS).toBeCloseTo(1200, -2)
    expect(jobTiming('scan', 'normal').steps * TICK_MS).toBeCloseTo(8000, -2)
    expect(jobTiming('align', 'fast').steps * TICK_MS).toBeCloseTo(1000, -2)
    expect(jobTiming('exportVideo', 'normal').steps * TICK_MS).toBeCloseTo(5000, -2)
    expect(chunkBoundaries(10, 4)).toEqual([3, 5, 8, 10])
  })

  // Deterministic (virtual time): wall-clock budgets flake under coverage and parallel runs.
  it('an instant job needs no simulated delay, only zero-delay ticks', async () => {
    vi.useFakeTimers()
    try {
      const b = backend('ready')
      const rec = recordJob<ScanEvent>()
      let finished = false
      await b.call('start_scan', { onEvent: rec.channel })
      void rec.done.then(() => {
        finished = true
      })
      await vi.advanceTimersByTimeAsync(5)
      expect(finished).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('scan job', () => {
  it('streams started → progress → finished after start resolves, and completes the scan', async () => {
    const b = backend('ready')
    const rec = recordJob<ScanEvent>()
    const jobId = await b.call('start_scan', { onEvent: rec.channel })
    expect(jobId).toMatch(/^scan-\d+$/)
    expect(rec.events).toHaveLength(0)
    expect((await b.call('get_session', {})).activeJob).toEqual({ jobId, kind: 'scan' })
    const events = await rec.done
    expectLifecycle(events, 'finished')
    expect(events[0]).toEqual({ type: 'started', jobId, total: 3593 })

    const progress = events.filter((e) => e.type === 'progress')
    const first = progress[0]!
    expect(first).toMatchObject({ done: 412, fromCache: 412, analyzed: 0 })
    expect(first.recent.length).toBeLessThanOrEqual(64)
    const last = progress.at(-1)!
    expect(last).toMatchObject({ done: 3593, total: 3593, analyzed: 3181, confirmed: 3529, uncertain: 41, etaMs: 0 })
    expect(last.photosPerSecond).toBeGreaterThan(37)
    expect(last.photosPerSecond).toBeLessThan(39)
    expect(last.currentFile).toBe(demoLibrary().photos.at(-1)?.relPath)

    const recent = progress.flatMap((p) => p.recent)
    const days = recent.map((r) => r.dayKey)
    expect(days).toEqual(days.slice().sort())
    for (const r of recent.slice(0, 50)) {
      const photo = demoLibrary().byId.get(r.id)!
      expect(r).toEqual({ id: photo.id, version: photo.version, dayKey: photo.dayKey, status: photo.status })
    }

    const summary = events.at(-1)!
    expect(summary).toMatchObject({ type: 'finished', jobId, total: 3593, fromCache: 412, analyzed: 3181, noFace: 17, failed: 0 })
    const s = await b.call('get_session', {})
    expect(s.activeJob).toBeNull()
    expect(s.scan.status).toBe('complete')
    expect(s.scan.lastSummary?.jobId).toBe(jobId)
    expect(s.scan.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(s.folder?.analyzedCount).toBe(3593)
    expect(s.counts).toMatchObject({ total: 3593, reviewPending: 41, days: 3518 })
  })

  it('reports 412 photos from the cache on a rescan', async () => {
    const b = backend('aligned')
    const rec = recordJob<ScanEvent>()
    await b.call('start_scan', { onEvent: rec.channel })
    const events = await rec.done
    expect(events.at(-1)).toMatchObject({ type: 'finished', fromCache: 412, analyzed: 3181 })
  })

  it('applies the busy rule while running, and cancel keeps partial work', async () => {
    const b = backend('ready')
    let jobId = ''
    const rec = recordJob<ScanEvent>((event, index) => {
      if (event.type === 'progress' && index === 2) void b.call('cancel_job', { jobId })
    })
    jobId = await b.call('start_scan', { onEvent: rec.channel })
    await rejects(b.call('set_reference_rotation', { rotationDeg: 1 }), 'busy', 'Another task is running. Wait for it to finish or cancel it.')
    await rejects(b.call('start_align', { render, onEvent: recordJob<AlignEvent>().channel }), 'busy')
    await rejects(b.call('pick_export_folder', {}), 'busy')
    await expect(b.call('get_photos', { query: { statuses: null } })).resolves.toBeInstanceOf(Array)
    await expect(b.call('reveal_path', { path: '/nope' })).rejects.toMatchObject({ kind: 'invalidArgument' })
    const events = await rec.done
    expectLifecycle(events, 'cancelled')
    const cancelled = events.at(-1)!
    expect(cancelled.type === 'cancelled' && cancelled.done).toBeGreaterThan(412)
    const s = await b.call('get_session', {})
    expect(s.scan.status).toBe('partial')
    expect(s.counts.total).toBe(cancelled.type === 'cancelled' ? cancelled.done : -1)
    expect(s.activeJob).toBeNull()

    const resume = recordJob<ScanEvent>()
    await b.call('start_scan', { onEvent: resume.channel })
    const resumed = await resume.done
    expect(resumed.at(-1)).toMatchObject({ type: 'finished', fromCache: s.folder?.analyzedCount })
  })

  it('cancels before the first progress with done 0; unknown ids are a no-op', async () => {
    const b = backend('ready')
    const rec = recordJob<ScanEvent>()
    const jobId = await b.call('start_scan', { onEvent: rec.channel })
    await b.call('cancel_job', { jobId })
    await b.call('cancel_job', { jobId })
    await expect(b.call('cancel_job', { jobId: 'scan-999' })).resolves.toBeNull()
    const events = await rec.done
    expect(events.map((e) => e.type)).toEqual(['started', 'cancelled'])
    expect(events[1]).toMatchObject({ done: 0 })
    expect((await b.call('get_session', {})).scan.status).toBe('none')
    await rejects(b.call('cancel_job', {} as never), 'invalidArgument')
  })

  it('fails midway with the injected error and keeps partial work', async () => {
    const b = backend('ready', { fail: { scanMidway: 'diskFull' } })
    const rec = recordJob<ScanEvent>()
    await b.call('start_scan', { onEvent: rec.channel })
    const events = await rec.done
    expectLifecycle(events, 'failed')
    expect(events.at(-1)).toMatchObject({ error: { kind: 'diskFull', message: 'The disk is full. Free some space and try again.' } })
    expect((await b.call('get_session', {})).scan.status).toBe('partial')
  })

  it('rejects at start: injected, no folder, no reference, no face in the crop', async () => {
    const channel = recordJob<ScanEvent>().channel
    await rejects(backend('ready', { fail: { start_scan: 'permissionDenied' } }).call('start_scan', { onEvent: channel }), 'permissionDenied')
    await rejects(backend('fresh').call('start_scan', { onEvent: channel }), 'notReady', 'Choose a source folder first.')
    const noRef = backend('fresh')
    await noRef.call('set_source_folder', { path: DEMO_FOLDER })
    await rejects(noRef.call('start_scan', { onEvent: channel }), 'notReady', /reference/)
    await noRef.call('set_reference_photo', { path: NO_FACE_REFERENCE_PATH })
    await rejects(noRef.call('start_scan', { onEvent: channel }), 'noFaceInReference', /No face found inside the crop/)
    await rejects(backend('ready').call('start_scan', { onEvent: {} } as never), 'invalidArgument')
  })

  it('scans an empty folder to completion', async () => {
    const b = backend('fresh')
    await b.call('set_reference_photo', { path: REFERENCE_PATH })
    await b.call('set_source_folder', { path: '/Users/demo/Pictures/Empty folder' })
    const rec = recordJob<ScanEvent>()
    await b.call('start_scan', { onEvent: rec.channel })
    expect((await rec.done).at(-1)).toMatchObject({ type: 'finished', total: 0 })
  })
})

describe('align job', () => {
  it('renders every active day, lists 3 failures, and leaves those days partial', async () => {
    const b = backend('reviewed')
    const rec = recordJob<AlignEvent>()
    const jobId = await b.call('start_align', { render: { ...render, backdrop: 'blurred' }, onEvent: rec.channel })
    const events = await rec.done
    expectLifecycle(events, 'finished')
    expect(events[0]).toEqual({ type: 'started', jobId, total: 3547 })
    const summary = events.at(-1)!
    if (summary.type !== 'finished') throw new Error('not finished')
    expect(summary).toMatchObject({ total: 3547, rendered: 3544, reused: 0, outputSize: { width: 1080, height: 1440 } })
    expect(summary.failed).toHaveLength(3)
    expect(summary.failed[0]?.error.kind).toBe('decodeFailed')

    const view = await b.call('get_frames', {})
    expect(view.status).toBe('partial')
    expect(view.frames).toHaveLength(3544)
    expect(view.render.backdrop).toBe('blurred')
    const versions = new Map(view.frames.map((f) => [f.photoId, f.version]))
    const recent = events.flatMap((e) => (e.type === 'progress' ? e.recent : []))
    expect(recent.length).toBeGreaterThan(0)
    for (const r of recent) expect(r.version).toBe(versions.get(r.id))
    expect(recent.map((r) => r.dayKey)).toEqual(recent.map((r) => r.dayKey).slice().sort())

    const again = recordJob<AlignEvent>()
    await b.call('start_align', { render: { ...render, backdrop: 'blurred' }, onEvent: again.channel })
    expect((await again.done).at(-1)).toMatchObject({ type: 'finished', rendered: 0, reused: 3544 })
  })

  it('completes when no failures are configured', async () => {
    const b = backend('reviewed', { alignFailures: 0 })
    const rec = recordJob<AlignEvent>()
    await b.call('start_align', { render, onEvent: rec.channel })
    await rec.done
    const s = await b.call('get_session', {})
    expect(s.frames).toEqual({ status: 'complete', count: 3547, expected: 3547, outputSize: { width: 1080, height: 1440 } })
  })

  it('makes frames stale when the render changes, and reuses them in the aligned scenario', async () => {
    const b = backend('aligned')
    const rec = recordJob<AlignEvent>()
    await b.call('start_align', { render, onEvent: rec.channel })
    expect((await rec.done).at(-1)).toMatchObject({ type: 'finished', reused: 3547, rendered: 0, failed: [] })
    const cancel = backend('aligned')
    let jobId = ''
    const partial = recordJob<AlignEvent>((e, i) => {
      if (e.type === 'progress' && i === 1) void cancel.call('cancel_job', { jobId })
    })
    jobId = await cancel.call('start_align', { render: { ...render, resolution: '720p' }, onEvent: partial.channel })
    const events = await partial.done
    expectLifecycle(events, 'cancelled')
    expect((await cancel.call('get_session', {})).frames.status).toBe('partial')
    expect((await cancel.call('get_frames', {})).outputSize).toEqual({ width: 720, height: 960 })
  })

  it('fails midway and rejects bad starts', async () => {
    const failing = backend('reviewed', { fail: { alignMidway: 'io' } })
    const rec = recordJob<AlignEvent>()
    await failing.call('start_align', { render, onEvent: rec.channel })
    expectLifecycle(await rec.done, 'failed')

    const channel = recordJob<AlignEvent>().channel
    await rejects(backend('ready').call('start_align', { render, onEvent: channel }), 'notReady')
    await rejects(backend('fresh').call('start_align', { render, onEvent: channel }), 'notReady')
    await rejects(backend('reviewed').call('start_align', { render: { ...render, resolution: '8k' as never }, onEvent: channel }), 'invalidArgument')
    const noFace = backend('reviewed')
    await noFace.call('set_reference_crop', { crop: { x: 0, y: 0, width: 400, height: 400 }, aspect: '1:1' })
    await rejects(noFace.call('start_align', { render, onEvent: channel }), 'noFaceInReference')
    expect((await noFace.call('get_session', {})).frames.status).toBe('none')
  })
})

describe('export jobs', () => {
  const settings = { format: 'png', jpegQuality: 95, overwrite: false } as const
  const dir = '/Users/demo/Pictures/Timelapse frames'

  it('writes YYYYMMDD files, then _1 suffixes on a second run', async () => {
    const b = backend('aligned')
    const rec = recordJob<ExportImagesEvent>()
    await b.call('start_export_images', { dir, settings, onEvent: rec.channel })
    const events = await rec.done
    expectLifecycle(events, 'finished')
    expect(events.at(-1)).toMatchObject({ type: 'finished', dir, written: 3547, renamed: 0 })
    expect(events.find((e) => e.type === 'progress')).toMatchObject({ total: 3547, currentFile: expect.stringMatching(/^\d{8}\.png$/) })
    await expect(b.call('reveal_path', { path: dir })).resolves.toBeNull()
    await expect(b.call('reveal_path', { path: `${dir}/20140502.png` })).resolves.toBeNull()

    const again = recordJob<ExportImagesEvent>()
    await b.call('start_export_images', { dir, settings: { ...settings, format: 'jpeg' }, onEvent: again.channel })
    expect((await again.done).at(-1)).toMatchObject({ renamed: 0 })
    const third = recordJob<ExportImagesEvent>()
    await b.call('start_export_images', { dir, settings, onEvent: third.channel })
    expect((await third.done).at(-1)).toMatchObject({ written: 3547, renamed: 3547 })
    await expect(b.call('reveal_path', { path: `${dir}/20140502_1.png` })).resolves.toBeNull()
    const overwrite = recordJob<ExportImagesEvent>()
    await b.call('start_export_images', { dir, settings: { ...settings, overwrite: true }, onEvent: overwrite.channel })
    expect((await overwrite.done).at(-1)).toMatchObject({ renamed: 0 })
    expect((await b.call('get_session', {})).imageExport.overwrite).toBe(true)
  })

  it('cancels and fails image exports, and validates arguments', async () => {
    const b = backend('aligned')
    let jobId = ''
    const rec = recordJob<ExportImagesEvent>((e, i) => {
      if (e.type === 'progress' && i === 1) void b.call('cancel_job', { jobId })
    })
    jobId = await b.call('start_export_images', { dir, settings, onEvent: rec.channel })
    expectLifecycle(await rec.done, 'cancelled')
    const failing = backend('aligned', { fail: { exportImagesMidway: 'diskFull' } })
    const failed = recordJob<ExportImagesEvent>()
    await failing.call('start_export_images', { dir, settings, onEvent: failed.channel })
    expectLifecycle(await failed.done, 'failed')

    const channel = recordJob<ExportImagesEvent>().channel
    await rejects(backend('reviewed').call('start_export_images', { dir, settings, onEvent: channel }), 'notReady', 'Align at least one day first.')
    await rejects(b.call('start_export_images', { dir: '/Users/demo/Nowhere', settings, onEvent: channel }), 'invalidArgument')
    await rejects(b.call('start_export_images', { dir: '/Users/demo/Pictures/Locked', settings, onEvent: channel }), 'permissionDenied')
    await rejects(b.call('start_export_images', { dir, settings: { ...settings, jpegQuality: 40 }, onEvent: channel }), 'invalidArgument')
    await rejects(b.call('start_export_images', { dir: 'frames', settings, onEvent: channel }), 'invalidArgument')
  })

  it('encodes the video with holds in framesTotal and a ~236 MB estimate', async () => {
    const b = backend('aligned')
    const s = await b.call('get_session', {})
    expect(s.video.pace).toEqual({ mode: 'fps', fps: 30 })
    const path = (await b.call('pick_video_path', { suggestedName: 'FaceTimelapse 2012–2022' }))!
    expect(path).toBe('/Users/demo/Movies/FaceTimelapse 2012–2022.mp4')
    const rec = recordJob<ExportVideoEvent>()
    await b.call('start_export_video', { path, settings: s.video, onEvent: rec.channel })
    const events = await rec.done
    expectLifecycle(events, 'finished')
    const progress = events.find((e) => e.type === 'progress')
    expect(progress).toMatchObject({ framesTotal: 3577 })
    const done = events.at(-1)!
    if (done.type !== 'finished') throw new Error('not finished')
    expect(done).toMatchObject({ path, frames: 3577 })
    expect(done.durationSecs).toBeCloseTo(119.233, 2)
    expect(done.bytes / 1e6).toBeGreaterThan(230)
    expect(done.bytes / 1e6).toBeLessThan(242)
    await expect(b.call('reveal_path', { path })).resolves.toBeNull()
    // v1.7: the finished video opens; anything else is one notFound.
    await expect(b.call('open_path', { path })).resolves.toBeNull()
    await rejects(b.call('open_path', { path: '/Users/demo/Movies/other.mp4' }), 'notFound')
    await rejects(b.call('open_path', { path: path.replace(/\.mp4$/, '.mov') }), 'notFound')
  })

  it('resolves duration pace, bitrate quality and crossfades', async () => {
    const b = backend('aligned')
    const base = (await b.call('get_session', {})).video
    const rec = recordJob<ExportVideoEvent>()
    const settings = {
      ...base,
      pace: { mode: 'duration' as const, seconds: 120 },
      quality: { bitrate: { kbps: 12_000 } },
      crossfade: { frames: 1, easing: 'linear' as const },
      caption: { position: 'bottomLeft' as const, size: 0.045, format: '%b %-d, %Y' },
      holdFirstSecs: 0.5,
    }
    await b.call('start_export_video', { path: '/Users/demo/Movies/a.mp4', settings, onEvent: rec.channel })
    const done = (await rec.done).at(-1)!
    if (done.type !== 'finished') throw new Error('not finished')
    expect(done.durationSecs).toBeGreaterThan(119)
    expect(done.durationSecs).toBeLessThan(121)
    expect(done.bytes).toBeCloseTo((12_000_000 / 8) * done.durationSecs, -6)
  })

  it('deletes the partial file on cancel and failure', async () => {
    const b = backend('aligned')
    const path = '/Users/demo/Movies/cancelled.mp4'
    let jobId = ''
    const rec = recordJob<ExportVideoEvent>((e, i) => {
      if (e.type === 'progress' && i === 1) void b.call('cancel_job', { jobId })
    })
    jobId = await b.call('start_export_video', { path, settings: b.current.video, onEvent: rec.channel })
    expectLifecycle(await rec.done, 'cancelled')
    await rejects(b.call('reveal_path', { path }), 'notFound', `This file is no longer there: ${path}`)

    const failing = backend('aligned', { fail: { exportVideoMidway: 'encodeFailed' } })
    const failed = recordJob<ExportVideoEvent>()
    await failing.call('start_export_video', { path, settings: failing.current.video, onEvent: failed.channel })
    const events = await failed.done
    expect(events.at(-1)).toMatchObject({ type: 'failed', error: { kind: 'encodeFailed' } })
  })

  it('validates video exports', async () => {
    const b = backend('aligned')
    const video = b.current.video
    const channel = recordJob<ExportVideoEvent>().channel
    const path = '/Users/demo/Movies/x.mp4'
    const bad = (patch: Record<string, unknown>) => ({ path, settings: { ...video, ...patch } as typeof video, onEvent: channel })
    await rejects(backend('aligned', { fail: { start_export_video: 'diskFull' } }).call('start_export_video', bad({})), 'diskFull')
    await rejects(backend('reviewed').call('start_export_video', bad({})), 'notReady', 'Align at least two days first.')
    await rejects(b.call('start_export_video', { ...bad({}), path: '/Users/demo/Movies/x.mov' }), 'invalidArgument', /\.mp4/)
    await rejects(b.call('start_export_video', { ...bad({}), path: '/Users/demo/Nope/x.mp4' }), 'invalidArgument')
    await rejects(b.call('start_export_video', bad({ pace: { mode: 'fps', fps: 90 } })), 'invalidArgument')
    await rejects(b.call('start_export_video', bad({ pace: { mode: 'duration', seconds: 500 } })), 'invalidArgument')
    await rejects(b.call('start_export_video', bad({ pace: { mode: 'duration', seconds: 5 } })), 'invalidArgument', /fps/)
    await rejects(b.call('start_export_video', bad({ pace: { mode: 'duration', seconds: 2 }, holdLastSecs: 3 })), 'invalidArgument', /holds/)
    await rejects(b.call('start_export_video', bad({ pace: { mode: 'speed' } })), 'invalidArgument')
    await rejects(b.call('start_export_video', bad({ resolution: '2160p' })), 'invalidArgument', /aligned at 1080 × 1440/)
    await rejects(b.call('start_export_video', bad({ quality: 'ultra' })), 'invalidArgument')
    await rejects(b.call('start_export_video', bad({ quality: { bitrate: { kbps: 5 } } })), 'invalidArgument')
    await rejects(b.call('start_export_video', bad({ crossfade: { frames: 31, easing: 'linear' } })), 'invalidArgument')
    await rejects(b.call('start_export_video', bad({ holdFirstSecs: 11 })), 'invalidArgument')
    await rejects(b.call('start_export_video', bad({ caption: { position: 'topLeft', size: 0.5, format: '%Y' } })), 'invalidArgument')
    await rejects(b.call('start_export_video', bad({ caption: { position: 'topLeft', size: 0.05, format: '' } })), 'invalidArgument')
    await rejects(b.call('start_export_video', bad({ caption: { position: 'topLeft', size: 0.05, format: '%Q' } })), 'invalidArgument')
    await rejects(b.call('start_export_video', bad({ caption: { position: 'middle', size: 0.05, format: '%Y' } })), 'invalidArgument')
    const ok = recordJob<ExportVideoEvent>()
    await b.call('start_export_video', { path, settings: { ...video, resolution: '720p' }, onEvent: ok.channel })
    expect((await ok.done).find((e) => e.type === 'progress')).toMatchObject({ framesTotal: 3577 })
  })
})
