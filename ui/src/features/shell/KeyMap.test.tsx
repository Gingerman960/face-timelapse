import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useView } from '../../state/view'
import { installFakeAnimations, removeFakeAnimations } from '../../components/ui/fakeAnimations'
import type { Step } from '../../lib/steps'
import { KeyMap } from './KeyMap'
import { useKeyMap } from './keyMapStore'

function Harness() {
  return (
    <>
      <button type="button">On the screen</button>
      <KeyMap />
    </>
  )
}

function openOn(step: Step, { exportOpen = false } = {}): HTMLElement {
  act(() => {
    useView.setState({ step, exportOpen })
    useKeyMap.getState().setOpen(true)
  })
  return screen.getByRole('dialog')
}

/** The intent groups in reading order, by their visible label. */
function groupLabels(dialog: HTMLElement): string[] {
  return within(dialog)
    .getAllByRole('group')
    .map((g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent ?? '')
}

beforeEach(() => {
  useKeyMap.setState({ open: false })
  useView.setState({ step: 'setup', exportOpen: false })
})

afterEach(() => {
  removeFakeAnimations()
})

describe('useKeyMap', () => {
  it('opens, closes and toggles', () => {
    // Act + Assert
    useKeyMap.getState().toggle()
    expect(useKeyMap.getState().open).toBe(true)
    useKeyMap.getState().toggle()
    expect(useKeyMap.getState().open).toBe(false)
    useKeyMap.getState().setOpen(true)
    expect(useKeyMap.getState().open).toBe(true)
  })
})

describe('KeyMap', () => {
  it('renders nothing until it is opened', () => {
    // Act
    render(<Harness />)

    // Assert
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens as a modal card titled with the screen it describes', () => {
    // Arrange
    render(<Harness />)

    // Act
    const dialog = openOn('days')

    // Assert
    expect(dialog).toHaveAccessibleName('Keys · Days')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Keys · Days' })).toBeInTheDocument()
  })

  it('lists the screen’s keys first, grouped Move · Decide · Look · Make, then Everywhere', () => {
    // Arrange
    render(<Harness />)

    // Act
    const dialog = openOn('days')

    // Assert
    expect(groupLabels(dialog)).toEqual(['Move', 'Decide', 'Look', 'Move', 'Look', 'Make'])
    const everywhere = within(dialog).getByRole('heading', { level: 3, name: 'Everywhere' })
    const zoom = within(dialog).getByText('Zoom out or in')
    expect(zoom.compareDocumentPosition(everywhere) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows each row’s keys as caps and says them in words (the glyphs are hidden from screen readers)', () => {
    // Arrange
    render(<Harness />)

    // Act
    const dialog = openOn('days')

    // Assert
    const zoom = within(dialog).getByText('Zoom out or in').closest('.km-row') as HTMLElement
    expect(within(zoom).getByText('Command Up arrow or Command Down arrow')).toHaveClass('visually-hidden')
    expect([...zoom.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⌘↑', '⌘↓'])
    for (const cap of dialog.querySelectorAll('kbd')) expect(cap).toHaveAttribute('aria-hidden', 'true')
    expect(within(dialog).getByText('Shift Command O')).toBeInTheDocument()
  })

  it('follows the screen: the player’s keys on Timelapse, why they rest while aligning', () => {
    // Arrange
    render(<Harness />)

    // Act + Assert
    const player = openOn('timelapse')
    expect(player).toHaveAccessibleName('Keys · Timelapse')
    expect(within(player).getByText('Full-window viewer')).toBeInTheDocument()
    expect(within(player).getByText('J, K or L')).toBeInTheDocument()

    act(() => useView.setState({ step: 'align' }))
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Keys · Timelapse')
    expect(screen.getByText('The player’s keys work once the frames are aligned.')).toBeInTheDocument()
    expect(screen.queryByText('Full-window viewer')).not.toBeInTheDocument()
  })

  it('over the export sheet, shows only the sheet’s own keys', () => {
    // Arrange
    render(<Harness />)

    // Act
    const dialog = openOn('timelapse', { exportOpen: true })

    // Assert
    expect(dialog).toHaveAccessibleName('Keys · Export')
    expect(within(dialog).queryByRole('heading', { name: 'Everywhere' })).not.toBeInTheDocument()
    expect(within(dialog).getByText('Stop encoding')).toBeInTheDocument()
  })

  it('moves focus into the card and gives it back on close', () => {
    // Arrange
    render(<Harness />)
    screen.getByRole('button', { name: 'On the screen' }).focus()

    // Act
    const dialog = openOn('review')

    // Assert
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useKeyMap.getState().open).toBe(false)
    expect(screen.getByRole('button', { name: 'On the screen' })).toHaveFocus()
  })

  it('keeps Tab inside the card', async () => {
    // Arrange
    render(<Harness />)
    const dialog = openOn('review')
    const close = within(dialog).getByRole('button', { name: 'Close' })

    // Act + Assert
    await userEvent.tab()
    expect(close).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(close).toHaveFocus()
  })

  it('puts itself away on “?” again, and keeps that key from reaching the screen', () => {
    // Arrange
    render(<Harness />)
    openOn('days')
    const screenKeys = vi.fn()
    window.addEventListener('keydown', screenKeys)

    // Act
    const press = createEvent.keyDown(window, { key: '?', shiftKey: true })
    fireEvent(window, press)

    // Assert
    expect(press.defaultPrevented).toBe(true)
    expect(screenKeys).not.toHaveBeenCalled()
    expect(useKeyMap.getState().open).toBe(false)
    window.removeEventListener('keydown', screenKeys)
  })

  it('stays open for ⌘? (the Help menu’s search) and for other keys', () => {
    // Arrange
    render(<Harness />)
    openOn('days')

    // Act
    fireEvent.keyDown(window, { key: '?', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'x' })

    // Assert
    expect(useKeyMap.getState().open).toBe(true)
  })

  it('closes on a click outside the card or on Close, not on a click inside', async () => {
    // Arrange
    render(<Harness />)
    const dialog = openOn('setup')

    // Act + Assert
    await userEvent.click(within(dialog).getByText('Level the eyes'))
    expect(useKeyMap.getState().open).toBe(true)
    fireEvent.click(document.querySelector('.keymap-scrim') as HTMLElement)
    expect(useKeyMap.getState().open).toBe(false)

    openOn('setup')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useKeyMap.getState().open).toBe(false)
  })

  it('leaves with a short exit, inert and no longer modal from its first frame', async () => {
    // Arrange
    const fake = installFakeAnimations()
    render(<Harness />)
    const dialog = openOn('days')

    // Act
    act(() => useKeyMap.getState().setOpen(false))

    // Assert
    const layer = document.querySelector('.keymap-layer') as HTMLElement
    expect(layer).toHaveAttribute('inert')
    expect(dialog).toHaveAttribute('aria-modal', 'false')
    const card = fake.calls.find((c) => c.target === dialog)
    expect(card?.keyframes).toEqual([{ opacity: 0, transform: 'translateY(6px) scale(0.98)' }])
    expect(card?.options.duration).toBeLessThan(220)
    const scrim = fake.calls.find((c) => c.target.classList.contains('keymap-scrim'))
    expect(scrim?.keyframes).toEqual([{ opacity: 0 }])
    await act(fake.finishAll)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('fades without moving under reduced motion', () => {
    // Arrange
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList,
    )
    const fake = installFakeAnimations()
    render(<Harness />)
    const dialog = openOn('days')

    // Act
    act(() => useKeyMap.getState().setOpen(false))

    // Assert
    expect(fake.calls.find((c) => c.target === dialog)?.keyframes).toEqual([{ opacity: 0 }])
  })
})
