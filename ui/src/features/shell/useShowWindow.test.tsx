import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useShowWindowWhenReady } from './useAppRuntime'

const show = vi.hoisted(() => vi.fn<() => Promise<void>>())
const tauri = vi.hoisted(() => ({ inside: true }))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ show }) }))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => tauri.inside,
}))

function Probe({ ready }: { ready: boolean }) {
  useShowWindowWhenReady(ready)
  return null
}

describe('useShowWindowWhenReady', () => {
  beforeEach(() => {
    tauri.inside = true
    show.mockReset()
  })

  it('shows the window once, after the app is ready', async () => {
    // Arrange
    show.mockResolvedValue(undefined)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 1
    })
    const { rerender } = render(<Probe ready={false} />)
    expect(show).not.toHaveBeenCalled()

    // Act
    rerender(<Probe ready />)
    rerender(<Probe ready={false} />)
    rerender(<Probe ready />)

    // Assert
    await waitFor(() => expect(show).toHaveBeenCalledOnce())
  })

  it('warns inside Tauri when the window cannot be shown', async () => {
    // Arrange
    show.mockRejectedValue(new Error('no window'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // Act
    render(<Probe ready />)

    // Assert
    await waitFor(() => expect(warn).toHaveBeenCalledWith('Could not show the window.', expect.any(Error)))
  })

  it('stays quiet in a plain browser', async () => {
    // Arrange
    tauri.inside = false
    show.mockRejectedValue(new Error('no window'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // Act
    render(<Probe ready />)

    // Assert
    await waitFor(() => expect(show).toHaveBeenCalled())
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
  })
})
