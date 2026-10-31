import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { resetStores } from '../../test/renderApp'
import { useView } from '../../state/view'
import { useApplyTheme, useMaxWidth, useThemeVersion } from './useTheme'

/** A controllable matchMedia: `set(query, matches)` flips a query and notifies its listeners. */
function fakeMatchMedia(initial: Record<string, boolean> = {}) {
  const state = new Map(Object.entries(initial))
  const listeners = new Map<string, Set<() => void>>()
  const impl = (query: string) => ({
    get matches() {
      return state.get(query) ?? false
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, fn: () => void) => {
      if (!listeners.has(query)) listeners.set(query, new Set())
      listeners.get(query)?.add(fn)
    },
    removeEventListener: (_: string, fn: () => void) => listeners.get(query)?.delete(fn),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })
  vi.spyOn(window, 'matchMedia').mockImplementation(impl as unknown as typeof window.matchMedia)
  return {
    set(query: string, matches: boolean) {
      state.set(query, matches)
      act(() => listeners.get(query)?.forEach((fn) => fn()))
    },
    listenerCount: (query: string) => listeners.get(query)?.size ?? 0,
  }
}

function Probe({ px = 1180 }: { px?: number }) {
  useApplyTheme()
  const version = useThemeVersion()
  const narrow = useMaxWidth(px)
  return <output aria-label="probe">{JSON.stringify({ version, narrow })}</output>
}

const probe = () => JSON.parse(screen.getByRole('status', { name: 'probe' }).textContent ?? '{}') as { version: number; narrow: boolean }

beforeEach(() => {
  resetStores()
  useView.setState({ theme: 'system' })
})

afterEach(() => {
  delete document.documentElement.dataset.theme
})

describe('useApplyTheme', () => {
  it('mirrors a chosen theme onto <html> and removes it for system', () => {
    // Arrange
    fakeMatchMedia()
    render(<Probe />)
    expect(document.documentElement.dataset.theme).toBeUndefined()

    // Act + Assert
    act(() => useView.getState().setTheme('dark'))
    expect(document.documentElement.dataset.theme).toBe('dark')
    act(() => useView.getState().setTheme('light'))
    expect(document.documentElement.dataset.theme).toBe('light')
    act(() => useView.getState().setTheme('system'))
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })
})

describe('useThemeVersion', () => {
  it('changes with the theme choice and with the OS appearance', () => {
    // Arrange
    const media = fakeMatchMedia()
    render(<Probe />)
    const v0 = probe().version

    // Act + Assert
    act(() => useView.getState().setTheme('light'))
    const vLight = probe().version
    act(() => useView.getState().setTheme('dark'))
    const vDark = probe().version
    media.set('(prefers-color-scheme: dark)', true)
    const vOs = probe().version

    expect(new Set([v0, vLight, vDark, vOs]).size).toBe(4)
  })
})

describe('useMaxWidth', () => {
  it('follows its media query live and unsubscribes on unmount', () => {
    // Arrange
    const media = fakeMatchMedia({ '(max-width: 900px)': true })
    const { unmount } = render(<Probe px={900} />)
    expect(probe()).toMatchObject({ narrow: true })

    // Act
    media.set('(max-width: 900px)', false)

    // Assert
    expect(probe()).toMatchObject({ narrow: false })
    unmount()
    expect(media.listenerCount('(max-width: 900px)')).toBe(0)
  })

  it('falls back to defaults where matchMedia is missing', () => {
    // Arrange
    const original = window.matchMedia
    Object.defineProperty(window, 'matchMedia', { value: undefined, writable: true, configurable: true })

    // Act
    try {
      render(<Probe />)

      // Assert
      expect(probe()).toEqual({ version: 0, narrow: false })
    } finally {
      Object.defineProperty(window, 'matchMedia', { value: original, writable: true, configurable: true })
    }
  })
})
