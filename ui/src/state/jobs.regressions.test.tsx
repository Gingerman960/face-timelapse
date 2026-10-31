// Regressions from UI review #1: H3 (post-job step flash and unhandled
// rejections), M1 (double start), M2 (orphan job after a reload), L12 (⌘2
// during the first scan), M9 (app keys behind a modal sheet).
import { afterEach, describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { RenderSettings, ScanEvent } from '../ipc/contract'
import { recordJob } from '../ipc/mock/testing'
import { renderApp } from '../test/renderApp'
import { startAlign, startScan, useJobs } from './jobs'
import { queryClient, queryKeys } from './queries'
import { useView } from './view'

const RENDER: RenderSettings = { resolution: '1080p', backdrop: 'extended', refineLandmarks: true }
const mod = { metaKey: true, ctrlKey: true }

afterEach(() => {
  window.__FT_MOCK__?.backend.loadScenario('fresh')
  delete window.__FT_MOCK__
})

function recordSteps(): { steps: string[]; stop: () => void } {
  const steps: string[] = []
  const stop = useView.subscribe((s, prev) => {
    if (s.step !== prev.step) steps.push(s.step)
  })
  return { steps, stop }
}

describe('H3: the step after a job comes from the fresh session', () => {
  it('a first scan goes Scan → Review without flashing the Reference screen', async () => {
    await renderApp({ scenario: 'ready', speed: 'instant' })
    const rec = recordSteps()
    await act(async () => {
      await startScan()
    })
    await waitFor(() => expect(useView.getState().step).toBe('review'), { timeout: 5000 })
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull())
    rec.stop()
    expect(rec.steps).toEqual(['scan', 'review'])
  })

  it('a first align goes to the timelapse without flashing Days', async () => {
    await renderApp({ scenario: 'reviewed', speed: 'instant', alignFailures: 0 })
    const rec = recordSteps()
    await act(async () => {
      await startAlign(RENDER)
    })
    await waitFor(() => expect(useView.getState().step).toBe('timelapse'), { timeout: 5000 })
    rec.stop()
    expect(rec.steps).toEqual(['align', 'timelapse'])
  })

  it('if the session can’t be re-read after a job, the job still ends and the error is shown', async () => {
    const { backend } = await renderApp({ scenario: 'ready', speed: 'fast' })
    await act(async () => {
      await startScan()
    })
    backend.configure({ fail: { get_session: 'io' } })
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull(), { timeout: 5000 })
    await waitFor(() => expect(useView.getState().toasts.some((t) => t.tone === 'stop')).toBe(true))
    backend.configure({ fail: {} })
  })
})

describe('M1: a double start runs one job', () => {
  it('two quick starts share one job: no wiped progress, no busy toast', async () => {
    await renderApp({ scenario: 'reviewed', speed: 'fast', alignFailures: 0 })
    const results = await act(async () => Promise.allSettled([startAlign(RENDER), startAlign(RENDER)]))
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    await waitFor(() => expect(useJobs.getState().align.total).toBeGreaterThan(0))
    expect(useView.getState().toasts).toEqual([])
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull(), { timeout: 8000 })
  })
})

describe('M2: a job the UI didn’t start (reload mid-job) is adopted', () => {
  it('shows the job as running, lets ⌘. cancel it, and returns to idle when it ends', async () => {
    const { backend } = await renderApp({ scenario: 'ready', speed: 'normal' })
    // A job started before this UI loaded: its channel belongs to the old page.
    const orphan = recordJob<ScanEvent>()
    await backend.call('start_scan', { onEvent: orphan.channel })
    // The UI only learns about it from the session (as after a webview reload).
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session })
    })
    await waitFor(() => expect(useJobs.getState().activeKind).toBe('scan'))
    fireEvent.keyDown(window, { key: '.', ...mod })
    await orphan.done
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull(), { timeout: 5000 })
  })
})

describe('L12 and M9: app shortcuts', () => {
  it('⌘2 opens the running first scan even though the cached session predates it', async () => {
    await renderApp({ scenario: 'ready', speed: 'normal' })
    await act(async () => {
      await startScan()
    })
    act(() => useView.getState().setStep('setup'))
    fireEvent.keyDown(window, { key: '2', ...mod })
    expect(useView.getState().step).toBe('scan')
    await act(async () => {
      fireEvent.keyDown(window, { key: '.', ...mod })
    })
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull(), { timeout: 8000 })
  })

  it('with the export sheet open, ⌘1–⌘5 and ⌘O do nothing behind it', async () => {
    await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: 'e' })
    await screen.findByRole('dialog', { name: 'Export timelapse' })
    fireEvent.keyDown(window, { key: '4', ...mod })
    fireEvent.keyDown(window, { key: 'o', ...mod })
    expect(useView.getState().step).toBe('timelapse')
    expect(screen.getByRole('dialog', { name: 'Export timelapse' })).toBeInTheDocument()
  })
})
