// v1.2 shell grant `core:window:allow-set-theme`: an explicit in-app Light/Dark
// choice is passed to the native window, so the title bar and the sidebar
// material follow it; System hands control back to the OS (null).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { resetStores } from '../../test/renderApp'
import { useView } from '../../state/view'
import { useApplyTheme } from './useTheme'

const setTheme = vi.hoisted(() => vi.fn<(theme: 'light' | 'dark' | null) => Promise<void>>())
const tauri = vi.hoisted(() => ({ inside: true }))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme }) }))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => tauri.inside,
}))

function Probe() {
  useApplyTheme()
  return null
}

const root = () => document.documentElement

beforeEach(() => {
  resetStores()
  tauri.inside = true
  setTheme.mockReset()
  setTheme.mockResolvedValue(undefined)
})
afterEach(() => {
  delete root().dataset.nativeTheme
  delete root().dataset.theme
})

describe('native window theme', () => {
  it('passes an explicit choice to the window and marks the material as following it', async () => {
    useView.setState({ theme: 'dark' })
    render(<Probe />)
    await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith('dark'))
    await waitFor(() => expect(root().dataset.nativeTheme).toBe('dark'))
  })

  it('System hands the window back to the OS', async () => {
    useView.setState({ theme: 'light' })
    render(<Probe />)
    await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith('light'))
    act(() => useView.getState().setTheme('system'))
    await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(null))
    expect(root().dataset.nativeTheme).toBeUndefined()
  })

  it('if the window refuses, the sidebar stays opaque (no native-theme mark)', async () => {
    setTheme.mockRejectedValue(new Error('not allowed'))
    useView.setState({ theme: 'dark' })
    render(<Probe />)
    await waitFor(() => expect(setTheme).toHaveBeenCalled())
    expect(root().dataset.nativeTheme).toBeUndefined()
  })

  it('does nothing outside Tauri', async () => {
    tauri.inside = false
    useView.setState({ theme: 'dark' })
    render(<Probe />)
    await new Promise((r) => setTimeout(r, 0))
    expect(setTheme).not.toHaveBeenCalled()
  })
})
