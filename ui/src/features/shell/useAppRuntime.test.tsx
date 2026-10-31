import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { SessionSnapshot } from '../../ipc/contract'
import { DEFAULT_MESSAGES } from '../../ipc/mock/errors'
import { renderApp } from '../../test/renderApp'
import { startAlign, startScan, useJobs } from '../../state/jobs'
import { queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'
import { nextFrameOrTimeout } from './useAppRuntime'

const mod = { metaKey: true, ctrlKey: true }
const title = () => screen.getByRole('heading', { level: 1 })
const view = () => useView.getState()
const session = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session) as SessionSnapshot

describe('global shortcuts', () => {
  it('⌘1–⌘5 open reachable steps only', async () => {
    // Arrange
    await renderApp({ scenario: 'reviewed' })

    // Act + Assert
    fireEvent.keyDown(window, { key: '1', ...mod })
    await waitFor(() => expect(title()).toHaveTextContent('Reference'))
    fireEvent.keyDown(window, { key: '4', ...mod })
    await waitFor(() => expect(title()).toHaveTextContent('Days'))
    fireEvent.keyDown(window, { key: '5', ...mod })
    expect(view().step).toBe('days')
    fireEvent.keyDown(window, { key: '1', ...mod, shiftKey: true })
    expect(view().step).toBe('days')
    fireEvent.keyDown(window, { key: '3', ...mod })
    await waitFor(() => expect(title()).toHaveTextContent('Review'))
  })

  it('⌘5 follows a running align', async () => {
    // Arrange
    const { backend } = await renderApp({ scenario: 'reviewed' })
    backend.configure({ speed: 'fast' })
    await act(async () => {
      await startAlign(session().render)
    })
    fireEvent.keyDown(window, { key: '1', ...mod })
    expect(view().step).toBe('setup')

    // Act
    fireEvent.keyDown(window, { key: '5', ...mod })

    // Assert
    expect(view().step).toBe('align')

    // Act: ⌘. stops the align, even from a text field.
    const field = document.createElement('input')
    document.body.append(field)
    fireEvent.keyDown(field, { key: '.', ...mod })
    field.remove()

    // Assert
    await waitFor(() => expect(useJobs.getState().align.cancelledAt).not.toBeNull())
    await waitFor(() => expect(view().step).toBe('days'))
  })

  it('⌘. with no job running does nothing', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })

    // Act
    fireEvent.keyDown(window, { key: '.', ...mod })

    // Assert
    expect(view().toasts).toEqual([])
  })

  it('⌘O picks a reference photo and opens the reference screen', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })
    expect(view().step).toBe('timelapse')

    // Act
    fireEvent.keyDown(window, { key: 'o', ...mod })

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Reference'))
  })

  it('⇧⌘O picks the library folder', async () => {
    // Arrange
    await renderApp({ scenario: 'fresh' })

    // Act
    fireEvent.keyDown(window, { key: 'O', shiftKey: true, ...mod })

    // Assert
    await waitFor(() => expect(session().folder?.name).toBe('Daily selfies'))
  })

  it('a cancelled ⌘O dialog keeps the current step', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned', cancelDialogs: true })

    // Act
    fireEvent.keyDown(window, { key: 'o', ...mod })

    // Assert
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    expect(view().step).toBe('timelapse')
  })

  it('a failing ⌘O dialog is reported as a toast', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned', fail: { pick_reference_photo: 'permissionDenied' } })

    // Act
    fireEvent.keyDown(window, { key: 'o', ...mod })

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.permissionDenied)).toBeInTheDocument()
  })

  it('⌘O is ignored while a job runs', async () => {
    // Arrange
    const { backend } = await renderApp({ scenario: 'ready' })
    backend.configure({ speed: 'fast' })
    await act(async () => {
      await startScan()
    })

    // Act
    fireEvent.keyDown(window, { key: 'o', ...mod })

    // Assert
    expect(view().step).toBe('scan')
    expect(view().toasts).toEqual([])
    fireEvent.keyDown(window, { key: '.', ...mod })
    await waitFor(() => expect(view().step).toBe('setup'))
  })

  it('⌃⌘S toggles the sidebar and ⌥⌘I the inspector', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })
    const { sidebarCollapsed, inspectorOpen } = view()

    // Act
    fireEvent.keyDown(window, { key: 's', metaKey: true, ctrlKey: true })
    fireEvent.keyDown(window, { key: 'ˆ', code: 'KeyI', altKey: true, ...mod })

    // Assert
    expect(view().sidebarCollapsed).toBe(!sidebarCollapsed)
    expect(view().inspectorOpen).toBe(!inspectorOpen)
    await waitFor(() => expect(document.querySelector('.window')).toHaveAttribute('data-sidebar', 'collapsed'))
  })

  it('ignores events that were already handled, and ⌘↩ inside a text field', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })
    const handled = (e: Event) => e.preventDefault()
    document.addEventListener('keydown', handled)
    const field = document.createElement('input')
    document.body.append(field)

    // Act
    fireEvent.keyDown(window.document.body, { key: 's', metaKey: true, ctrlKey: true })
    document.removeEventListener('keydown', handled)
    const notPrevented = fireEvent.keyDown(field, { key: 'Enter', ...mod })
    field.remove()

    // Assert
    expect(view().sidebarCollapsed).toBe(false)
    expect(notPrevented).toBe(true)
    expect(useJobs.getState().activeJobId).toBeNull()
  })
})

describe('nextFrameOrTimeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves on the next animation frame', async () => {
    // Arrange
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 1
    })

    // Act + Assert
    await expect(nextFrameOrTimeout(10_000)).resolves.toBeUndefined()
    expect(raf).toHaveBeenCalledOnce()
  })

  it('resolves after the timeout when no frame comes (hidden window)', async () => {
    // Arrange
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    let resolved = false
    const pending = nextFrameOrTimeout(50).then(() => {
      resolved = true
    })

    // Act
    await vi.advanceTimersByTimeAsync(49)
    const early = resolved
    await vi.advanceTimersByTimeAsync(1)
    await pending

    // Assert
    expect(early).toBe(false)
    expect(resolved).toBe(true)
  })
})
