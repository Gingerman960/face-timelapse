// The window's own fallbacks: a session that can't load, and a crashing export sheet (UI review 2, M7).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderApp } from './test/renderApp'
import { useJobs } from './state/jobs'
import { useView } from './state/view'

vi.mock('./features/export/ExportSheet', () => ({
  default: function BrokenSheet(): never {
    throw new Error('Sheet broke')
  },
}))
vi.mock('./lib/reload', () => ({ reloadWindow: vi.fn() }))
import { reloadWindow } from './lib/reload'

afterEach(() => {
  delete window.__FT_MOCK__
})

describe('App fallbacks', () => {
  it('a session that cannot load says so, and Try again asks again', async () => {
    const { backend } = await renderApp({ scenario: 'aligned', fail: { get_session: 'io' } })
    const notice = await screen.findByRole('alert')
    expect(notice).toHaveTextContent("FaceTimelapse couldn't start.")
    backend.configure({ fail: {} })
    fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('toolbar', { name: 'Playback' })).toBeInTheDocument()
  })

  it('a crashing export sheet closes with a toast and leaves the timelapse as it was', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    fireEvent.keyDown(window, { key: 'e' })
    await waitFor(() => expect(useView.getState().exportOpen).toBe(false))
    expect(useView.getState().toasts[0]?.message).toBe('The export sheet stopped working (Sheet broke). Open it again with E.')
    expect(screen.getByRole('toolbar', { name: 'Playback' })).toBeInTheDocument()
  })
})

// UI review 3, L4: E can't open the sheet while the export runs, so the message mustn't say so.
describe('a crashing export sheet during an export', () => {
  it('says the export goes on instead of "Open it again with E"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    act(() => {
      useJobs.setState({ activeJobId: 'job-9', activeKind: 'exportVideo' })
      useView.getState().setExportOpen(true)
    })
    await waitFor(() => expect(useView.getState().exportOpen).toBe(false))
    expect(useView.getState().toasts[0]?.message).toBe('The export sheet stopped working (Sheet broke). The export goes on; its progress shows in the sidebar.')
    act(() => useJobs.setState({ activeJobId: null, activeKind: null }))
  })
})

describe('the crash panel', () => {
  it('reloads the window on request', async () => {
    const { CrashPanel } = await import('./components/ui/ErrorBoundary')
    const { render } = await import('@testing-library/react')
    render(<CrashPanel title="Days" error={new Error('x')} />)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reload the window' }))
    expect(reloadWindow).toHaveBeenCalled()
  })
})
