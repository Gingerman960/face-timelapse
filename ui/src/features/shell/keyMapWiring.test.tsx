// Critique round 5, P2-13: no keyboard map. ? lays the Keys card over any screen.
import { describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderApp } from '../../test/renderApp'
import { useJobs } from '../../state/jobs'
import { mod, openSheet } from '../export/exportSheetTesting'
import { useKeyMap } from './keyMapStore'

describe('the ? key', () => {
  it('opens the Keys card for the current screen, and ? again puts it away', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })

    // Act
    fireEvent.keyDown(window, { key: '?', shiftKey: true })

    // Assert
    expect(await screen.findByRole('dialog', { name: /Keys/ })).toHaveTextContent(/Timelapse/)
    fireEvent.keyDown(window, { key: '?', shiftKey: true })
    await waitFor(() => expect(useKeyMap.getState().open).toBe(false))
  })

  it('rests while typing in a field', async () => {
    await renderApp({ scenario: 'aligned' })
    const field = document.createElement('input')
    document.body.append(field)
    fireEvent.keyDown(field, { key: '?', shiftKey: true })
    expect(useKeyMap.getState().open).toBe(false)
    field.remove()
  })

  // UI review 6, L2: the card registered no primary action, so the export sheet's ⌘↩ under it still exported.
  it('holds ⌘↩ while the card is open over the export sheet; the sheet has it back once the card is put away', async () => {
    // Arrange
    const { ui } = await openSheet()
    fireEvent.keyDown(window, { key: '?', shiftKey: true })
    await screen.findByRole('dialog', { name: /Keys/ })

    // Act
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert: nothing exports.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(useJobs.getState().activeKind).toBeNull()
    expect(ui.queryByRole('heading', { name: 'Saved' })).toBeNull()

    // Act: put the card away, then ⌘↩.
    fireEvent.keyDown(window, { key: '?', shiftKey: true })
    await waitFor(() => expect(useKeyMap.getState().open).toBe(false))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Keys/ })).toBeNull())
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
  })
})

// Critique round 6, P1-3: the card couldn't be found. Help › Keyboard Shortcuts (⌘/) in the
// native menu emits the listen-only app event `show-keys` (contract v1.8), which lays it out.
describe('Help › Keyboard Shortcuts (show-keys, v1.8)', () => {
  it('opens the Keys card for the current screen, and a second click keeps it on the table', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })

    // Act
    await act(async () => {
      await window.__FT_MOCK__?.emitShowKeys()
    })

    // Assert
    expect(await screen.findByRole('dialog', { name: /Keys/ })).toHaveTextContent(/Timelapse/)
    await act(async () => {
      await window.__FT_MOCK__?.emitShowKeys()
    })
    expect(useKeyMap.getState().open).toBe(true)
  })
})
