// Every anchored popover closes on Escape and leaves things as they were:
// Appearance, Start a new timelapse, Forget earlier scan results, and Stop
// scanning. (Their exits now animate; Escape must still reach them at once.)
import { afterEach, describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SessionSnapshot } from '../../ipc/contract'
import { renderApp } from '../../test/renderApp'
import { stubLayout } from '../../test/layout'
import { queryClient, queryKeys } from '../../state/queries'
import { startScan } from '../../state/jobs'

const mod = { metaKey: true, ctrlKey: true }
const session = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session) as SessionSnapshot

afterEach(() => {
  delete window.__FT_MOCK__
})

async function escapeCloses(open: () => Promise<void>, name: string) {
  await open()
  expect(screen.getByRole('dialog', { name })).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name })).toBeNull())
}

describe('Escape closes a popover and changes nothing', () => {
  it('Appearance and Start a new timelapse, in the sidebar', async () => {
    await renderApp({ scenario: 'aligned' })
    const theme = document.documentElement.getAttribute('data-theme')
    await escapeCloses(() => userEvent.click(screen.getByRole('button', { name: 'Appearance' })), 'Appearance')
    expect(document.documentElement.getAttribute('data-theme')).toBe(theme)
    await escapeCloses(() => userEvent.click(screen.getByRole('button', { name: 'Project options' })), 'Start a new timelapse?')
    expect(session().reference).not.toBeNull()
  })

  it('Forget earlier scan results, in the Reference inspector', async () => {
    await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '1', ...mod })
    const inspector = within(await screen.findByRole('complementary', { name: 'Reference settings' }))
    await escapeCloses(() => userEvent.click(inspector.getByRole('button', { name: /Forget earlier scan results/ })), 'Forget earlier scan results?')
    expect(session().folder?.analyzedCount).toBeGreaterThan(0)
  })

  it('Stop scanning?, while a scan runs: it keeps scanning', async () => {
    stubLayout()
    const { backend } = await renderApp({ scenario: 'ready', speed: 'normal' })
    await act(async () => {
      void startScan()
    })
    await screen.findByRole('button', { name: /^Stop/ })
    await escapeCloses(() => userEvent.click(screen.getByRole('button', { name: /^Stop/ })), 'Stop scanning?')
    expect(backend.activeJob).not.toBeNull()
  })
})

describe('a ledger row fetches its screen ahead', () => {
  it('on a hover, for rows that can be visited', async () => {
    await renderApp({ scenario: 'aligned' })
    const ledger = within(screen.getByRole('navigation', { name: 'Project' }))
    fireEvent.pointerEnter(ledger.getByRole('button', { name: /^Days/ }))
    fireEvent.click(ledger.getByRole('button', { name: /^Days/ }))
    // Days' code may still be on its way under a loaded test run: a generous wait, not a fixed delay.
    expect(await screen.findByRole('complementary', { name: 'Selected day' }, { timeout: 5000 })).toBeInTheDocument()
  })
})
