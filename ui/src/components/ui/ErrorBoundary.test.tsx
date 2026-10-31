// UI review 2, M7: a render-time throw unmounted the whole root and left a
// blank window. Each screen now has its own boundary (and the root one).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { DayGroup } from '../../ipc/contract'
import { renderApp } from '../../test/renderApp'
import { queryClient, queryKeys } from '../../state/queries'
import { CrashPanel, ErrorBoundary } from './ErrorBoundary'

const mod = { metaKey: true, ctrlKey: true }

afterEach(() => {
  delete window.__FT_MOCK__
})

/** Throws while `boom.on`, renders fine after. */
const boom = { on: true }
function Fragile() {
  if (boom.on) throw new RangeError('Not a day: "2014-13-40"')
  return <p>All good</p>
}

describe('ErrorBoundary', () => {
  it('shows the fallback for a render-time throw, and Try again renders the children again', () => {
    // Arrange: React reports the caught error on the console; keep the test output quiet.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    boom.on = true
    render(
      <ErrorBoundary fallback={(error, retry) => <CrashPanel title="Days" error={error} onRetry={retry} />}>
        <Fragile />
      </ErrorBoundary>,
    )

    // Assert: calm words, the reason, and both ways out.
    const panel = screen.getByRole('alert')
    expect(panel).toHaveTextContent('Days stopped working')
    expect(panel).toHaveTextContent('Nothing you made is lost')
    expect(panel).toHaveTextContent('RangeError: Not a day')
    expect(within(panel).getByRole('button', { name: 'Reload the window' })).toBeInTheDocument()

    // Act
    boom.on = false
    fireEvent.click(within(panel).getByRole('button', { name: 'Try again' }))

    // Assert
    expect(screen.getByText('All good')).toBeInTheDocument()
  })
})

describe('one screen crashing', () => {
  it('keeps the window and the sidebar, and the other screens still open', async () => {
    // Arrange: a malformed day key from the backend makes Days throw while rendering.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await renderApp({ scenario: 'aligned' })
    const days = queryClient.getQueryData<DayGroup[]>(queryKeys.days)
    act(() => {
      queryClient.setQueryData<DayGroup[]>(queryKeys.days, (prev) => [...(prev ?? []), { ...(prev?.[0] as DayGroup), dayKey: '2014-13-40' }])
    })

    // Act
    fireEvent.keyDown(window, { key: '4', ...mod })

    // Assert
    expect(await screen.findByText('Days stopped working')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Project' })).toBeInTheDocument()
    act(() => queryClient.setQueryData(queryKeys.days, days))
    fireEvent.keyDown(window, { key: '5', ...mod })
    expect(await screen.findByRole('toolbar', { name: 'Playback' })).toBeInTheDocument()
  })
})
