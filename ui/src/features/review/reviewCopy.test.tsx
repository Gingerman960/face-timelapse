// QA 5: counts read naturally for one photo, and the done state has one plate.
import { afterEach, describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { PhotoSummary, SessionSnapshot } from '../../ipc/contract'
import { renderApp } from '../../test/renderApp'
import { stubLayout } from '../../test/layout'
import { queryClient, queryKeys } from '../../state/queries'
import { deriveLedger } from '../shell/ledger'
import { makeSession } from '../../test/session'

const mod = { metaKey: true, ctrlKey: true }

afterEach(() => {
  delete window.__FT_MOCK__
})

async function reviewWithOnlyOneUnsure() {
  await renderApp({ scenario: 'scanned' })
  const list = queryClient.getQueryData<PhotoSummary[]>(queryKeys.photos(['uncertain']))
  fireEvent.keyDown(window, { key: '3', ...mod })
  await screen.findByRole('button', { name: 'Keep' })
  const all = queryClient.getQueryData<PhotoSummary[]>(queryKeys.photos(['uncertain'])) ?? list ?? []
  act(() => {
    queryClient.setQueryData(queryKeys.photos(['uncertain']), all.slice(0, 1))
  })
}

describe('Review copy for a single unsure photo', () => {
  it('says "1 photo", and the done state has one Continue plate', async () => {
    await reviewWithOnlyOneUnsure()
    expect(await screen.findByText('1 photo the scan wasn’t sure about')).toBeInTheDocument()
    // QA batch 9: "1 stay out" read wrong.
    expect(screen.getByRole('button', { name: /^Skip to Days/ })).toHaveTextContent('Skip to Days · 1 stays out')
    fireEvent.keyDown(window, { key: 'y' })
    expect(await screen.findByRole('heading', { name: 'All looked at' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Continue to Days/ })).toHaveLength(1)
  })

  it('the ledger and scan copy pluralise too', () => {
    const s = makeSession('scanned')
    const one = { ...s, counts: { ...s.counts, uncertain: 1, reviewPending: 0, activeDays: 1 } }
    const rows = deriveLedger(one, null)
    expect(rows.find((r) => r.id === 'review')?.text).toBe('1 looked at')
    expect(rows.find((r) => r.id === 'days')?.text).toBe('1 day chosen')
  })
})

describe('Review done state (critique P2-6)', () => {
  it('the ledger follows decisions at once, before they are sent', async () => {
    await reviewWithOnlyOneUnsure()
    fireEvent.keyDown(window, { key: 'y' })
    const ledger = screen.getByRole('navigation', { name: 'Project' })
    // The session still says "1 of N left" until the batch is sent; the ledger reads the list.
    await waitFor(() => expect(within(ledger).getByRole('button', { name: /^Review/ })).toHaveTextContent(/looked at/))
    // Still before the batch went out (300 ms idle).
    expect(queryClient.getQueryData<SessionSnapshot>(queryKeys.session)?.counts.reviewPending).toBeGreaterThan(0)
  })

  it('keeps only the toolbar plate and shows the reviewed strip instead of a void', async () => {
    stubLayout(1200, 800)
    await reviewWithOnlyOneUnsure()
    fireEvent.keyDown(window, { key: 'y' })
    await screen.findByRole('heading', { name: 'All looked at' })
    const plates = screen.getAllByRole('button', { name: /^Continue to Days/ })
    expect(plates).toHaveLength(1)
    expect(plates[0]?.closest('.toolbar')).not.toBeNull()
    const strip = screen.getByRole('list', { name: 'Reviewed photos' })
    // It scrolls, and has nothing focusable inside: the strip itself takes focus (axe).
    expect(strip).toHaveAttribute('tabindex', '0')
    expect(within(strip).getAllByRole('listitem')[0]).toHaveAccessibleName(/^Kept, /)
  })
})
