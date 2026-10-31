import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { Channel } from '@tauri-apps/api/core'
import type { ImageExportSettings, RenderSettings, ScanEvent, SessionSnapshot, VideoSettings } from '../ipc/contract'
import { installMockBackend, type MockOptions } from '../ipc/mock/install'
import { EXPORT_FOLDER, MOVIES } from '../ipc/mock/mockFs'
import { DEFAULT_MESSAGES } from '../ipc/mock/errors'
import { makeSession } from '../test/session'
import { resetStores } from '../test/renderApp'
import {
  cancelActiveJob,
  resetExportTracks,
  startAlign,
  startExportImages,
  startExportVideo,
  startScan,
  useJobs,
} from './jobs'
import { queryClient, queryKeys } from './queries'
import { useView } from './view'

const RENDER: RenderSettings = { resolution: '1080p', backdrop: 'dimmed', refineLandmarks: true }
const VIDEO: VideoSettings = makeSession('aligned').video
const IMAGES: ImageExportSettings = { format: 'png', jpegQuality: 95, overwrite: false }
const VIDEO_PATH = `${MOVIES}/FaceTimelapse 2014–2024.mp4`

function setup(opts: Partial<MockOptions> = {}) {
  resetStores()
  useView.setState({ step: 'setup', toasts: [] })
  return installMockBackend({ scenario: 'ready', speed: 'instant', ...opts })
}

const jobs = () => useJobs.getState()
const view = () => useView.getState()
const toastMessages = () => view().toasts.map((t) => t.message)

/** Waits until no job is active and the post-job step has been applied. */
async function waitForStep(step: string): Promise<void> {
  await vi.waitFor(() => {
    expect(jobs().activeJobId).toBeNull()
    expect(view().step).toBe(step)
  })
}

async function waitIdle(): Promise<void> {
  await vi.waitFor(() => expect(jobs().activeJobId).toBeNull())
}

afterEach(() => {
  window.__FT_MOCK__?.backend.loadScenario('fresh')
  delete window.__FT_MOCK__
})

describe('startScan', () => {
  it('tracks progress and recent photos, then opens Review when unsure photos are waiting', async () => {
    // Arrange
    setup({ scenario: 'ready' })

    // Act
    await startScan()

    // Assert
    expect(jobs().activeKind).toBe('scan')
    expect(jobs().activeJobId).toMatch(/^scan-/)
    expect(view().step).toBe('scan')
    await waitForStep('review')
    const scan = jobs().scan
    expect(scan.total).toBe(3593)
    expect(scan.progress).toMatchObject({ type: 'progress', done: 3593, total: 3593 })
    expect(scan.recent.length).toBeGreaterThan(0)
    expect(scan.summary).toMatchObject({ type: 'finished', total: 3593, uncertain: 41 })
    expect(scan.error).toBeNull()
    expect(scan.cancelledAt).toBeNull()
    expect(jobs().activeKind).toBeNull()
    expect(queryClient.getQueryData<SessionSnapshot>(queryKeys.session)?.scan.status).toBe('complete')
  })

  it('returns to the reference and shows a stop toast when the scan fails midway', async () => {
    // Arrange
    setup({ scenario: 'ready', fail: { scanMidway: 'diskFull' } })

    // Act
    await startScan()
    await waitForStep('setup')

    // Assert
    expect(jobs().scan.error).toEqual({ kind: 'diskFull', message: DEFAULT_MESSAGES.diskFull })
    expect(jobs().scan.summary).toBeNull()
    expect(view().toasts).toEqual([expect.objectContaining({ message: DEFAULT_MESSAGES.diskFull, tone: 'stop' })])
  })

  it('records where a cancelled scan stopped and goes back to the reference without a toast', async () => {
    // Arrange
    setup({ scenario: 'ready' })
    await startScan()

    // Act
    await cancelActiveJob()
    await waitForStep('setup')

    // Assert
    expect(jobs().scan.cancelledAt).toBe(0)
    expect(jobs().scan.summary).toBeNull()
    expect(view().toasts).toEqual([])
  })

  it('rejects with the backend error when the scan cannot start, leaving no active job', async () => {
    // Arrange
    setup({ scenario: 'ready', fail: { start_scan: 'permissionDenied' } })

    // Act
    const started = startScan()

    // Assert
    await expect(started).rejects.toEqual({ kind: 'permissionDenied', message: DEFAULT_MESSAGES.permissionDenied })
    expect(jobs().activeJobId).toBeNull()
    expect(view().step).toBe('setup')
  })

  it('keeps earlier recent photos when a progress event brings none', async () => {
    // Arrange: a hand-rolled backend that streams one empty and one non-empty batch.
    resetStores()
    useView.setState({ step: 'setup', toasts: [] })
    const session = makeSession('scanned', { counts: { ...makeSession('scanned').counts, reviewPending: 0 } })
    const recent = [{ id: 'p1', version: 'v1', dayKey: '2014-01-01', status: 'confirmed' as const }]
    const base = { jobId: 'scan-9', total: 2, fromCache: 0, analyzed: 1, confirmed: 1, uncertain: 0, rejected: 0, noFace: 0, failed: 0, currentFile: null, photosPerSecond: 1, etaMs: 0 }
    mockIPC((cmd, args) => {
      if (cmd === 'get_session') return session
      if (cmd !== 'start_scan') return null
      const ch = (args as { onEvent: Channel<ScanEvent> }).onEvent
      setTimeout(() => {
        ch.onmessage({ type: 'started', jobId: 'scan-9', total: 2 })
        ch.onmessage({ type: 'progress', done: 1, recent, ...base })
        ch.onmessage({ type: 'progress', done: 2, recent: [], ...base })
        ch.onmessage({ type: 'finished', jobId: 'scan-9', total: 2, fromCache: 0, analyzed: 2, confirmed: 2, uncertain: 0, rejected: 0, noFace: 0, failed: 0, durationMs: 5 })
      }, 0)
      return 'scan-9'
    })

    // Act
    await startScan()
    await waitForStep('days')

    // Assert
    expect(jobs().scan.recent).toEqual(recent)
    expect(jobs().scan.progress).toMatchObject({ done: 2 })
  })
})

describe('startAlign', () => {
  it('opens the timelapse after a finished align', async () => {
    // Arrange
    setup({ scenario: 'reviewed', alignFailures: 2 })

    // Act
    await startAlign(RENDER)

    // Assert
    expect(view().step).toBe('align')
    expect(jobs().activeKind).toBe('align')
    await waitForStep('timelapse')
    const align = jobs().align
    expect(align.total).toBeGreaterThan(0)
    expect(align.progress?.done).toBe(align.total)
    expect(align.recent.length).toBeGreaterThan(0)
    expect(align.summary?.failed).toHaveLength(2)
    expect(view().toasts).toEqual([])
  })

  it('falls back to Days with a stop toast when the align fails midway', async () => {
    // Arrange
    setup({ scenario: 'reviewed', fail: { alignMidway: 'io' } })

    // Act
    await startAlign(RENDER)
    await waitForStep('days')

    // Assert
    expect(jobs().align.error).toEqual({ kind: 'io', message: DEFAULT_MESSAGES.io })
    expect(toastMessages()).toEqual([DEFAULT_MESSAGES.io])
  })

  it('says how far a cancelled align got and stays on Days', async () => {
    // Arrange
    setup({ scenario: 'reviewed' })
    let requested = false
    const unsubscribe = useJobs.subscribe((s) => {
      if (s.align.progress && !requested) {
        requested = true
        void cancelActiveJob()
      }
    })

    // Act: stop right after the first batch of frames.
    await startAlign(RENDER)
    await waitForStep('days')
    unsubscribe()

    // Assert
    const { total, cancelledAt } = jobs().align
    const done = cancelledAt ?? -1
    expect(done).toBeGreaterThan(0)
    expect(done).toBeLessThan(total)
    await vi.waitFor(() =>
      expect(view().toasts).toEqual([
        expect.objectContaining({
          tone: 'info',
          message: `Aligned ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}. Align again to continue.`,
        }),
      ]),
    )
  })
})

describe('startExportVideo', () => {
  it('records the saved file and marks the session stale without changing the step', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    useView.setState({ step: 'timelapse' })
    await queryClient.fetchQuery({ queryKey: queryKeys.session, queryFn: () => window.__FT_MOCK__!.backend.call('get_session', {}) })

    // Act
    await startExportVideo(VIDEO_PATH, VIDEO)
    expect(jobs().activeKind).toBe('exportVideo')
    await waitIdle()

    // Assert
    const track = jobs().exportVideo
    expect(track.total).toBeGreaterThan(0)
    expect(track.progress).not.toBeNull()
    expect(track.summary).toMatchObject({ type: 'finished', path: VIDEO_PATH })
    expect(queryClient.getQueryState(queryKeys.session)?.isInvalidated).toBe(true)
    expect(view().step).toBe('timelapse')
  })

  it('keeps the error of a failed encode for the sheet to show', async () => {
    // Arrange
    setup({ scenario: 'aligned', fail: { exportVideoMidway: 'encodeFailed' } })

    // Act
    await startExportVideo(VIDEO_PATH, VIDEO)
    await waitIdle()

    // Assert
    expect(jobs().exportVideo.error).toEqual({ kind: 'encodeFailed', message: DEFAULT_MESSAGES.encodeFailed })
    expect(jobs().exportVideo.summary).toBeNull()
    expect(view().toasts).toEqual([])
  })

  it('marks a stopped encode as cancelled', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    await startExportVideo(VIDEO_PATH, VIDEO)

    // Act
    await cancelActiveJob()
    await waitIdle()

    // Assert
    expect(jobs().exportVideo.cancelledAt).toBe(0)
    expect(jobs().exportVideo.summary).toBeNull()
  })
})

describe('startExportImages', () => {
  it('records how many files were written', async () => {
    // Arrange
    setup({ scenario: 'aligned' })

    // Act
    await startExportImages(EXPORT_FOLDER, IMAGES)
    expect(jobs().activeKind).toBe('exportImages')
    await waitIdle()

    // Assert
    const track = jobs().exportImages
    expect(track.total).toBeGreaterThan(0)
    expect(track.progress).not.toBeNull()
    expect(track.summary).toMatchObject({ type: 'finished', dir: EXPORT_FOLDER })
    expect(track.summary?.written).toBe(track.total)
  })

  it('keeps the error of a failed image export', async () => {
    // Arrange
    setup({ scenario: 'aligned', fail: { exportImagesMidway: 'diskFull' } })

    // Act
    await startExportImages(EXPORT_FOLDER, IMAGES)
    await waitIdle()

    // Assert
    expect(jobs().exportImages.error).toMatchObject({ kind: 'diskFull' })
  })

  it('marks a stopped image export as cancelled', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    await startExportImages(EXPORT_FOLDER, IMAGES)

    // Act
    await cancelActiveJob()
    await waitIdle()

    // Assert
    expect(jobs().exportImages.cancelledAt).toBe(0)
  })
})

describe('one job at a time', () => {
  it('refuses every other job with BUSY while one runs', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    await startScan()
    const busy = { kind: 'busy', message: DEFAULT_MESSAGES.busy }

    // Act + Assert
    await expect(startScan()).rejects.toEqual(busy)
    await expect(startAlign(RENDER)).rejects.toEqual(busy)
    await expect(startExportVideo(VIDEO_PATH, VIDEO)).rejects.toEqual(busy)
    await expect(startExportImages(EXPORT_FOLDER, IMAGES)).rejects.toEqual(busy)
    expect(jobs().activeKind).toBe('scan')
    await waitIdle()
  })
})

describe('cancelActiveJob', () => {
  it('does nothing when no job runs', async () => {
    // Arrange
    setup()
    const handler = vi.fn()
    mockIPC(handler)

    // Act
    await cancelActiveJob()

    // Assert
    expect(handler).not.toHaveBeenCalled()
    expect(view().toasts).toEqual([])
  })

  it('shows a stop toast when the backend refuses to cancel', async () => {
    // Arrange
    const backend = setup({ scenario: 'aligned' })
    await startExportImages(EXPORT_FOLDER, IMAGES)
    backend.configure({ fail: { cancel_job: 'internal' } })

    // Act
    await cancelActiveJob()

    // Assert
    expect(toastMessages()).toEqual([DEFAULT_MESSAGES.internal])
    expect(view().toasts[0]?.tone).toBe('stop')
    await waitIdle()
    expect(jobs().exportImages.summary).not.toBeNull()
  })
})

describe('resetExportTracks', () => {
  it('clears both export results so the sheet returns to its settings', async () => {
    // Arrange
    setup({ scenario: 'aligned' })
    await startExportImages(EXPORT_FOLDER, IMAGES)
    await waitIdle()
    expect(jobs().exportImages.summary).not.toBeNull()

    // Act
    resetExportTracks()

    // Assert
    for (const track of [jobs().exportImages, jobs().exportVideo]) {
      expect(track).toEqual({ progress: null, total: 0, recent: [], summary: null, error: null, cancelledAt: null })
    }
  })
})
