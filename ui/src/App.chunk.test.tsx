// UI review 3, L4: a screen whose code failed to load can't be fixed by Try
// again (the import stays failed until the window reloads), so only Reload is offered.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderApp } from './test/renderApp'
import { isChunkLoadError } from './components/ui/ErrorBoundary'

// What the boundary receives when the browser can't fetch a screen's chunk (thrown at render here,
// since a vi.mock factory's own error is wrapped by Vitest).
vi.mock('./features/days/DaysScreen', () => ({
  default: function Unloadable(): never {
    throw new TypeError('Failed to fetch dynamically imported module: http://localhost:1420/src/features/days/DaysScreen.tsx')
  },
}))

afterEach(() => {
  delete window.__FT_MOCK__
})

describe('a screen whose code failed to load', () => {
  it('offers Reload only', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '4', metaKey: true, ctrlKey: true })
    const panel = await screen.findByRole('alert')
    expect(panel).toHaveTextContent('Days stopped working')
    expect(within(panel).queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(within(panel).getByRole('button', { name: 'Reload the window' })).toBeInTheDocument()
  })
})

describe('isChunkLoadError', () => {
  it('knows the browsers’ chunk-load messages and nothing else', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: x.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: x.js'))).toBe(true)
    expect(isChunkLoadError(new RangeError('Not a day'))).toBe(false)
  })
})
