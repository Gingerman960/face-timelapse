// QA (real app): with the face models missing the UI showed no notice at all.
// Contract v1.6: `AppInfo.modelsReady` / `modelsError` say ready, failed or
// still loading, and `models-changed` says when the startup load has ended.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react'
import type { SessionSnapshot } from '../ipc/contract'
import { DEFAULT_MESSAGES } from '../ipc/mock/errors'
import { renderApp } from '../test/renderApp'
import { queryClient, queryKeys } from './queries'
import { MODELS_LOADING, MODELS_MISSING, modelsStatus, useModelsInfo, useModelsWatch, withModelsNote } from './models'
import { onModelsChanged } from '../ipc/events'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('../ipc/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc/events')>()
  return { ...actual, onModelsChanged: vi.fn(actual.onModelsChanged) }
})

const mod = { metaKey: true, ctrlKey: true }
const Providers = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
const sidebar = () => within(screen.getByRole('navigation', { name: 'Project' }))
const notice = () => sidebar().queryByRole('status', { name: 'Face models are missing' })
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

afterEach(() => {
  delete window.__FT_MOCK__
})

describe('models status (v1.6)', () => {
  it('is ready, failed or loading from app info alone', () => {
    expect(modelsStatus({ modelsReady: true, modelsError: null })).toBe('ready')
    expect(modelsStatus({ modelsReady: false, modelsError: 'gone' })).toBe('missing')
    expect(modelsStatus({ modelsReady: false, modelsError: null })).toBe('loading')
    expect(modelsStatus(undefined)).toBe('loading')
  })

  // UI review 4, M1: §7.1 commands give up after 2 s while the load still runs;
  // that answer used to latch "missing" and send the user off to reinstall.
  it('reads a modelUnavailable answer by app info: missing once the load failed, still loading before it ended', () => {
    const reread = vi.spyOn(queryClient, 'invalidateQueries')
    expect(withModelsNote({ kind: 'io', message: 'x' })).toEqual({ kind: 'io', message: 'x' })
    expect(reread).not.toHaveBeenCalled()

    queryClient.setQueryData(queryKeys.appInfo, { modelsReady: false, modelsError: 'The face models couldn’t be loaded.' })
    expect(withModelsNote({ kind: 'modelUnavailable', message: 'x' })).toEqual({ kind: 'modelUnavailable', message: MODELS_MISSING })

    queryClient.setQueryData(queryKeys.appInfo, { modelsReady: false, modelsError: null })
    expect(withModelsNote({ kind: 'modelUnavailable', message: 'timed out' })).toEqual({ kind: 'modelUnavailable', message: MODELS_LOADING })
    expect(reread).toHaveBeenCalledWith({ queryKey: queryKeys.appInfo })
    queryClient.removeQueries({ queryKey: queryKeys.appInfo })
  })
})

describe('reading the models: subscribe, then read, then re-read on the event', () => {
  it('re-reads app info once subscribed, so a load that ended before then is not missed', async () => {
    // Arrange: a subscription that resolves only when the test says so.
    let subscribed: () => void = () => undefined
    const handlers: Array<() => void> = []
    vi.mocked(onModelsChanged).mockImplementationOnce((handler) => {
      handlers.push(handler)
      return new Promise((resolve) => (subscribed = () => resolve(() => undefined)))
    })
    const reread = vi.spyOn(queryClient, 'invalidateQueries')

    // Act + Assert: nothing is read again until the subscription is live…
    const { unmount } = renderHook(() => useModelsWatch())
    expect(reread).not.toHaveBeenCalledWith({ queryKey: queryKeys.appInfo })
    await act(async () => subscribed())
    // …then app info is read once more, and again on every event.
    expect(reread).toHaveBeenCalledTimes(1)
    act(() => handlers[0]?.())
    expect(reread).toHaveBeenCalledTimes(2)
    unmount()
  })
})

describe('a watch that ends before its subscription is live', () => {
  it('stops the late subscription instead of keeping it', async () => {
    let subscribed: () => void = () => undefined
    const stop = vi.fn()
    vi.mocked(onModelsChanged).mockImplementationOnce(() => new Promise((resolve) => (subscribed = () => resolve(stop))))
    const { unmount } = renderHook(() => useModelsWatch())
    unmount()
    await act(async () => subscribed())
    expect(stop).toHaveBeenCalled()
  })
})

describe('the app while the models load, and after', () => {
  it('a command that gave up waiting for a slow load says to try again, and latches nothing', async () => {
    // Arrange: the load outlasts the 2 s a command waits (§7.1).
    await renderApp({ scenario: 'ready', modelsLoading: true })

    // Act
    fireEvent.click(screen.getByRole('button', { name: /^Scan library/ }))

    // Assert: a try-again note; no reinstall notice; nothing turned off.
    expect(await screen.findByText(MODELS_LOADING)).toBeInTheDocument()
    expect(screen.queryByText(MODELS_MISSING)).toBeNull()
    expect(notice()).toBeNull()
    expect(screen.getByRole('button', { name: /^Scan library/ })).toBeEnabled()
    const { result } = renderHook(() => useModelsInfo(), { wrapper: Providers })
    expect(result.current.status).toBe('loading')
  })

  it('a slow load raises no alarm and turns nothing off', async () => {
    await renderApp({ scenario: 'ready', modelsLoading: true })
    await wait(400)
    expect(notice()).toBeNull()
    expect(screen.getByRole('button', { name: /^Scan library/ })).toBeEnabled()
  })

  it('loading, then ready: still no notice', async () => {
    const { backend } = await renderApp({ scenario: 'ready', modelsLoading: true })
    backend.configure({ modelsLoading: false })
    await act(async () => {
      await window.__FT_MOCK__?.emitModelsChanged()
    })
    await waitFor(() => expect(queryClient.getQueryData<{ modelsReady: boolean }>(queryKeys.appInfo)?.modelsReady).toBe(true))
    expect(notice()).toBeNull()
  })

  it('loading, then failed: the notice with the backend’s reason, and the controls that need the models off', async () => {
    // Arrange
    const { backend } = await renderApp({ scenario: 'aligned', modelsLoading: true })
    expect(notice()).toBeNull()

    // Act: the load ends in failure.
    backend.configure({ modelsLoading: false, modelsMissing: true })
    await act(async () => {
      await window.__FT_MOCK__?.emitModelsChanged()
    })

    // Assert: the notice, on every screen.
    // Critique round 3: calm and concise, the backend's reason on demand.
    const shown = await sidebar().findByRole('status', { name: 'Face models are missing' })
    expect(shown).toHaveTextContent('Reinstall FaceTimelapse to scan or align.')
    expect(shown).toHaveTextContent('Watching and exporting the frames you have still work.')
    expect(shown).not.toHaveTextContent(DEFAULT_MESSAGES.modelUnavailable)
    fireEvent.click(within(shown).getByRole('button', { name: 'Details' }))
    expect(shown).toHaveTextContent(DEFAULT_MESSAGES.modelUnavailable)
    expect(within(shown).getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true')

    // Days: Add a photo is off, with the reason.
    fireEvent.keyDown(window, { key: '4', ...mod })
    const add = await screen.findByRole('button', { name: /Add a photo to this day/ })
    expect(add).toBeDisabled()
    expect(add).toHaveAttribute('title', MODELS_MISSING)

    // Timelapse: watching and exporting still work.
    fireEvent.keyDown(window, { key: '5', ...mod })
    expect(await screen.findByRole('toolbar', { name: 'Playback' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Export…/ })).toBeEnabled()
  })

  it('a load that failed before the app subscribed still shows the notice, promising only what is there', async () => {
    await renderApp({ scenario: 'ready', modelsMissing: true })
    const shown = await sidebar().findByRole('status', { name: 'Face models are missing' })
    // An empty library (a session that never had the models restores nothing): no promise at all.
    expect(queryClient.getQueryData<SessionSnapshot>(queryKeys.session)?.counts.total).toBe(0)
    expect(shown).toHaveTextContent('Faces can’t be found until FaceTimelapse is reinstalled.')
    expect(shown).not.toHaveTextContent(/still work/)
    expect(shown).not.toHaveTextContent('Reinstall FaceTimelapse to scan or align.')
    const plate = screen.getByRole('button', { name: /^Scan library/ })
    expect(plate).toBeDisabled()
    expect(plate).toHaveAttribute('title', MODELS_MISSING)
  })

  it('with photos but no frames yet it promises review, not watching (N5: a read-only restore)', async () => {
    await renderApp({ scenario: 'scanned', modelsMissing: true })
    const shown = await sidebar().findByRole('status', { name: 'Face models are missing' })
    expect(queryClient.getQueryData<SessionSnapshot>(queryKeys.session)?.frames.count).toBe(0)
    expect(shown).toHaveTextContent('Reinstall FaceTimelapse to scan or align.')
    expect(shown).toHaveTextContent('Reviewing photos and choosing days still work.')
    expect(shown).not.toHaveTextContent(/frames you have/)
  })

  it('a stopped scan can’t be resumed: the plate says why', async () => {
    await renderApp({ scenario: 'aligned', modelsMissing: true })
    act(() => {
      queryClient.setQueryData<SessionSnapshot>(queryKeys.session, (s) => (s ? { ...s, scan: { ...s.scan, status: 'partial' } } : s))
    })
    fireEvent.keyDown(window, { key: '2', ...mod })
    const resume = await screen.findByRole('button', { name: /^Resume scan/ })
    await waitFor(() => expect(resume).toBeDisabled())
    expect(resume).toHaveAttribute('title', MODELS_MISSING)
  })

  it('a command answered after the load failed reads app info again, so the notice comes even without the event', async () => {
    // Arrange: loading, and the first try only says to wait.
    const { backend } = await renderApp({ scenario: 'ready', modelsLoading: true })
    fireEvent.click(screen.getByRole('button', { name: /^Scan library/ }))
    expect(await screen.findByText(MODELS_LOADING)).toBeInTheDocument()

    // Act: the load fails (its event not yet seen), and the user tries again.
    backend.configure({ modelsLoading: false, modelsMissing: true })
    fireEvent.click(screen.getByRole('button', { name: /^Scan library/ }))

    // Assert
    expect(await sidebar().findByRole('status', { name: 'Face models are missing' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /^Scan library/ })).toBeDisabled())
  })
})
