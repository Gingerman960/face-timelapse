// Contract v1.2: the backend may change the session on its own (dev autoload,
// a stale restored reference re-analyzed after the models load) and says so
// with the `session-changed` app event; the UI re-reads everything derived.
import { afterEach, describe, expect, it } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import type { SessionSnapshot } from '../../ipc/contract'
import { renderApp } from '../../test/renderApp'
import { queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'

const session = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session)

afterEach(() => {
  delete window.__FT_MOCK__
})

describe('session-changed (v1.2)', () => {
  it('re-reads the session and its derived data when the backend changes it on its own', async () => {
    const { backend } = await renderApp({ scenario: 'fresh' })
    expect(session()?.reference).toBeNull()

    // The backend sets a reference and folder without a command from this page (dev autoload).
    backend.loadScenario('ready')
    await act(async () => {
      await window.__FT_MOCK__?.emitSessionChanged()
    })

    await waitFor(() => expect(session()?.reference).not.toBeNull())
    expect(await screen.findByRole('group', { name: /^Crop/ })).toBeInTheDocument()
  })

  // REFERENCE_VERSION 2: a restored reference is re-analysed once at startup, so
  // every aligned frame goes stale until one re-align. That is a calm next step, not an error.
  it('presents frames made stale by a re-analysed reference as days to re-align, not as an error', async () => {
    // Arrange: the timelapse is open on aligned frames.
    const { backend } = await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })

    // Act: the backend re-analyses the reference on its own, which stales every frame.
    await backend.call('set_reference_crop', { crop: { x: 700, y: 0, width: 1776, height: 2368 }, aspect: '3:4' })
    await act(async () => {
      await window.__FT_MOCK__?.emitSessionChanged()
    })

    // Assert: Days offers the re-align; the ledger says how many days; nothing reads as a failure.
    await waitFor(() => expect(useView.getState().step).toBe('days'))
    expect(await screen.findByRole('button', { name: /^Re-align 3,547 days/ })).toBeInTheDocument()
    const ledger = within(screen.getByRole('navigation'))
    expect(ledger.getByText('Re-align 3,547')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector(".toast[data-tone=stop], .notice-stop")).toBeNull()
  })
})
