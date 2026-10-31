// QA 29: paths on screen are shortened ("~" and a truncated middle) with the
// full path in a tooltip; the real path is never altered for the backend.
import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderApp } from '../../test/renderApp'
import { DEMO_FOLDER } from '../../ipc/mock/fixtures'

const mod = { metaKey: true, ctrlKey: true }

afterEach(() => {
  delete window.__FT_MOCK__
})

describe('paths on screen', () => {
  it('the library subtitle shows ~/… with the full path as its tooltip', async () => {
    await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '2', ...mod })
    const shown = await screen.findByText('~/Pictures/Daily selfies')
    expect(shown).toHaveAttribute('title', DEMO_FOLDER)
    expect(screen.queryByText(DEMO_FOLDER)).toBeNull()
  })

  it('the Reference inspector shows the folder the same way', async () => {
    await renderApp({ scenario: 'ready' })
    const shown = await screen.findByText('~/Pictures/Daily selfies')
    expect(shown).toHaveAttribute('title', DEMO_FOLDER)
  })
})
