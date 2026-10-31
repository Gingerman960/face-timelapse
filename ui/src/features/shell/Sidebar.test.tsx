// QA batch 9: a snapshot taken while the Mac was locked showed the ledger's
// highlight still on Reference with Review on screen. The current row and the
// screen read the same `step`; this pins that they always agree.
import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderApp } from '../../test/renderApp'

const mod = { metaKey: true, ctrlKey: true }
const title = () => screen.getByRole('heading', { level: 1 })
const current = () => within(screen.getByRole('navigation', { name: 'Project' })).getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'page')

afterEach(() => {
  delete window.__FT_MOCK__
})

describe('the ledger’s current row', () => {
  it('follows the screen on show, on every step', async () => {
    // Arrange
    await renderApp({ scenario: 'scanned' })

    for (const [key, name] of [
      ['1', 'Reference'],
      ['3', 'Review'],
      ['4', 'Days'],
      ['2', 'Scan'],
    ] as const) {
      // Act
      fireEvent.keyDown(window, { key, ...mod })

      // Assert: one current row, the screen's own.
      await waitFor(() => expect(title()).toHaveTextContent(name))
      expect(current()).toHaveLength(1)
      expect(current()[0]).toHaveAccessibleName(new RegExp(`^${name}`))
    }
  })
})

// Critique round 4, items 17 and 26.
describe('the ledger’s labels', () => {
  it('every stage carries its name, status and key as a tooltip (the rail hides the words)', async () => {
    await renderApp({ scenario: 'aligned' })
    const days = within(screen.getByRole('navigation', { name: 'Project' })).getByRole('button', { name: /^Days/ })
    expect(days.getAttribute('title')).toMatch(/^Days · [\d,]+ days chosen ⌘4$/)
  })

  it('names the project by its decade, with the folder and its count under it', async () => {
    await renderApp({ scenario: 'aligned' })
    const header = screen.getByRole('navigation', { name: 'Project' }).querySelector('.project') as HTMLElement
    await waitFor(() => expect(header.querySelector('strong')).toHaveTextContent(/^\d{4} – \d{4}$/))
    expect(header.querySelector('.meta')).toHaveTextContent(/^.+ · [\d,]+$/)
  })

  it('before a scan, the folder is the name and the count reads in words', async () => {
    await renderApp({ scenario: 'ready' })
    const header = screen.getByRole('navigation', { name: 'Project' }).querySelector('.project') as HTMLElement
    expect(header.querySelector('.meta')).toHaveTextContent(/^[\d,]+ photos$/)
  })
})

