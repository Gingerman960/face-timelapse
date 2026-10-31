// Critique round 5, P1-4: after every step change focus fell to <body>, so
// keyboard and VoiceOver users lost their place. It now lands on the new
// screen (its labelled region, no ring), and the change is said politely.
import { afterEach, describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderApp } from '../../test/renderApp'
import { useView } from '../../state/view'
import { TRANSITION_CLASS } from './stepTransition'

type Doc = { startViewTransition?: unknown }
const doc = () => document as unknown as Doc

afterEach(() => {
  delete doc().startViewTransition
  document.documentElement.classList.remove(TRANSITION_CLASS)
})

/** Like a browser: the update callback runs a frame later, after the old screen is captured. */
function deferredTransitions() {
  doc().startViewTransition = (update: () => void) => {
    const done = new Promise<void>((resolve) =>
      setTimeout(() => {
        update()
        resolve()
      }, 16),
    )
    return { ready: done, updateCallbackDone: done, finished: done }
  }
}

/** The first enabled button of a region. */
const firstButton = (region: HTMLElement) => within(region).getAllByRole('button').find((b) => !(b as HTMLButtonElement).disabled) as HTMLElement

const goToDays = () => fireEvent.keyDown(window, { key: '4', metaKey: true, ctrlKey: true })
const announced = (text: string) => screen.getAllByRole('status').some((el) => el.textContent === text)

describe('focus after a step change', () => {
  it('lands on the new screen instead of <body>, and the change is announced', async () => {
    // Arrange: focus a control of the Timelapse screen, which unmounts with it.
    await renderApp({ scenario: 'aligned' })
    const timelapse = await screen.findByRole('region', { name: 'Timelapse' })
    firstButton(timelapse).focus()
    expect(timelapse).toContainElement(document.activeElement as HTMLElement)

    // Act
    goToDays()

    // Assert
    const days = await screen.findByRole('region', { name: 'Days' })
    await waitFor(() => expect(document.activeElement).toBe(days))
    expect(days).toHaveAttribute('tabindex', '-1')
    expect(announced('Days')).toBe(true)
  })

  it('also lands on the new screen when the transition applies a frame late', async () => {
    deferredTransitions()
    await renderApp({ scenario: 'aligned' })
    await waitFor(() => expect(firstButton(screen.getByRole('region', { name: 'Timelapse' }))).toBeDefined())
    firstButton(screen.getByRole('region', { name: 'Timelapse' })).focus()

    goToDays()

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Days' })))
    expect(announced('Days')).toBe(true)
  })

  it('stays where it is when it was outside the screen (the ledger)', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })
    const ledger = screen.getByRole('navigation', { name: 'Project' })
    const row = firstButton(ledger)
    row.focus()

    // Act
    act(() => useView.getState().setStep('days'))

    // Assert: the change is still said, and focus keeps its place.
    await screen.findByRole('region', { name: 'Days' })
    await waitFor(() => expect(announced('Days')).toBe(true))
    expect(document.activeElement).toBe(row)
  })
})
