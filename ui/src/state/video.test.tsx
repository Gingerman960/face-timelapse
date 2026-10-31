// Contract v1.5: the video settings (one pace everywhere) are saved with
// `set_video_settings` after a quiet spell, survive a restart, and an old
// draft never leaks into a new session (UI review 2, L8).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from '../App'
import type { SessionSnapshot } from '../ipc/contract'
import { call } from '../ipc/client'
import { DEFAULT_MESSAGES } from '../ipc/mock/errors'
import { DEMO_FOLDER } from '../ipc/mock/fixtures'
import { renderApp, resetStores } from '../test/renderApp'
import { withDaysPerSecond } from '../lib/pace'
import { resetSession, setSourceFolder } from './actions'
import { queryClient, queryKeys } from './queries'
import { VIDEO_SAVE_DELAY_MS, getVideoSettings, setVideoSettings } from './video'
import { useVideoDraft } from './videoDraft'

const session = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session) as SessionSnapshot
const quiet = () => act(() => new Promise((resolve) => setTimeout(resolve, VIDEO_SAVE_DELAY_MS + 150)))
const ledger = () => within(screen.getByRole('navigation', { name: 'Project' }))

afterEach(() => {
  delete window.__FT_MOCK__
})

describe('video settings are saved (v1.5)', () => {
  it('a pace change saves once after a quiet spell and survives a restart', async () => {
    // Arrange
    const { backend } = await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    const handle = vi.spyOn(backend, 'handle')
    const saves = () => handle.mock.calls.filter(([cmd]) => cmd === 'set_video_settings')

    // Act: two quick changes, as from typing.
    act(() => setVideoSettings(withDaysPerSecond(session().video, 20)))
    act(() => setVideoSettings(withDaysPerSecond(session().video, 10)))

    // Assert: shown at once, saved once (the last one) after the quiet spell.
    expect(ledger().getByText('5:56 · 10 days/s')).toBeInTheDocument()
    expect(saves()).toHaveLength(0)
    await quiet()
    expect(saves()).toHaveLength(1)
    expect(backend.current.video.pace).toEqual({ mode: 'fps', fps: 10 })
    expect(useVideoDraft.getState().draft).toBeNull()
    expect(session().video.pace).toEqual({ mode: 'fps', fps: 10 })

    // Act: restart the window against the same backend.
    cleanup()
    resetStores()
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    )

    // Assert
    expect(await ledger().findByText('5:56 · 10 days/s')).toBeInTheDocument()
  })

  it('an old draft never leaks into a new session, and its save never lands there', async () => {
    // Arrange
    const { backend } = await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    const defaults = { ...backend.current.video }
    act(() => setVideoSettings(withDaysPerSecond(session().video, 5)))

    // Act: Start over before the save goes out.
    await act(async () => {
      await resetSession()
    })
    await quiet()

    // Assert
    expect(useVideoDraft.getState().draft).toBeNull()
    expect(getVideoSettings()?.pace).toEqual(backend.current.video.pace)
    expect(backend.current.video.pace).not.toEqual(withDaysPerSecond(defaults, 5).pace)
  })

  // UI review 3, M2: a session read already in flight answered after the save and put the old pace back.
  it('a session read in flight when the save lands never brings the old settings back', async () => {
    // Arrange: the next session read answers 800 ms late, with the state from when it was asked.
    const { backend } = await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    const handle = backend.handle
    let slow = true
    Object.defineProperty(backend, 'handle', {
      value: async (cmd: string, payload?: unknown) => {
        const result = await handle(cmd, payload)
        if (cmd === 'get_session' && slow) {
          slow = false
          await new Promise((resolve) => setTimeout(resolve, 800))
        }
        return result
      },
    })
    void queryClient.invalidateQueries({ queryKey: queryKeys.session })
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))

    // Act
    act(() => setVideoSettings({ ...session().video, pace: { mode: 'fps', fps: 23 } }))
    await act(() => new Promise((resolve) => setTimeout(resolve, 1200)))

    // Assert
    expect(backend.current.video.pace).toEqual({ mode: 'fps', fps: 23 })
    expect(getVideoSettings()?.pace).toEqual({ mode: 'fps', fps: 23 })
  })

  // UI review 4, L1: cancelling that read reverted it, so whoever awaited it
  // (afterJob's fresh session read) got the snapshot from before the read.
  it('someone awaiting that session read gets a fresh session, not the one from before it', async () => {
    // Arrange: the backend moves on (fps 15), and its next session read answers late.
    const { backend } = await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    const before = session().video
    await backend.call('set_video_settings', { settings: { ...before, pace: { mode: 'fps', fps: 15 } } })
    const handle = backend.handle
    let slow = true
    Object.defineProperty(backend, 'handle', {
      value: async (cmd: string, payload?: unknown) => {
        const result = await handle(cmd, payload)
        if (cmd === 'get_session' && slow) {
          slow = false
          await new Promise((resolve) => setTimeout(resolve, 800))
        }
        return result
      },
    })
    // What afterJob's fresh session read does once the session is invalidated: fetch it and take the answer.
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.session, refetchType: 'none' }))
    let got: SessionSnapshot | null = null
    const read = queryClient.fetchQuery({ queryKey: queryKeys.session, queryFn: () => call('get_session') }).then((s) => {
      got = s
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))

    // Act: a pace save lands while that read is in flight.
    act(() => setVideoSettings({ ...before, pace: { mode: 'fps', fps: 23 } }))
    await act(async () => {
      await read
    })

    // Assert: the awaiter sees the backend as it is now, never the old pace.
    expect((got as SessionSnapshot | null)?.video.pace).toEqual({ mode: 'fps', fps: 23 })
    expect(getVideoSettings()?.pace).toEqual({ mode: 'fps', fps: 23 })
  })

  // UI review 3, L2: the video settings are the session's, not the folder's.
  it('an edit just before choosing another folder is still saved', async () => {
    const { backend } = await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    backend.grant([DEMO_FOLDER])
    act(() => setVideoSettings({ ...session().video, pace: { mode: 'fps', fps: 23 } }))
    await act(async () => {
      await setSourceFolder(DEMO_FOLDER)
    })
    await quiet()
    expect(backend.current.video.pace).toEqual({ mode: 'fps', fps: 23 })
  })

  it('Start over drops an unsaved edit before the reset, so it can never land in the new session', async () => {
    // Arrange: the reset takes longer than the save's quiet spell, and a save
    // sent meanwhile reaches the backend after the reset.
    const { backend } = await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    const handle = backend.handle
    const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    Object.defineProperty(backend, 'handle', {
      value: async (cmd: string, payload?: unknown) => {
        if (cmd === 'reset_session') await later(VIDEO_SAVE_DELAY_MS * 2)
        if (cmd === 'set_video_settings') await later(VIDEO_SAVE_DELAY_MS * 3)
        return handle(cmd, payload)
      },
    })
    act(() => setVideoSettings({ ...session().video, pace: { mode: 'fps', fps: 23 } }))

    // Act
    await act(async () => {
      await resetSession()
    })
    await act(() => later(VIDEO_SAVE_DELAY_MS * 4))

    // Assert
    expect(backend.current.video.pace).not.toEqual({ mode: 'fps', fps: 23 })
    expect(getVideoSettings()?.pace).toEqual(backend.current.video.pace)
  })

  it('a refused draft stays on screen with the backend’s message', async () => {
    // Arrange
    const { backend } = await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    backend.configure({ fail: { set_video_settings: 'invalidArgument' } })
    fireEvent.keyDown(window, { key: 'e' })
    const sheet = within(await screen.findByRole('dialog', { name: 'Export timelapse' }))

    // Act
    const pace = sheet.getByRole('textbox', { name: 'Days a second' })
    await userEvent.clear(pace)
    await userEvent.type(pace, '12{Enter}')
    await quiet()

    // Assert
    expect(pace).toHaveValue('12')
    expect(sheet.getByRole('alert')).toHaveTextContent(DEFAULT_MESSAGES.invalidArgument)
    expect(useVideoDraft.getState().error?.kind).toBe('invalidArgument')
  })
})
