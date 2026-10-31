import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { resetStores } from '../../test/renderApp'
import { useView } from '../../state/view'
import { Notice, Popover, Toasts, useFocusTrap } from './Overlays'
import { installFakeAnimations, removeFakeAnimations } from './fakeAnimations'

type Placement = 'below-end' | 'above-start' | 'above-center'

function PopoverHarness({ placement, empty = false, onClose }: { placement?: Placement; empty?: boolean; onClose?: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen(true)}>
        Open menu
      </button>
      <button type="button">Elsewhere</button>
      <Popover
        anchor={anchor}
        open={open}
        placement={placement}
        width={200}
        labelledBy="pop-title"
        onClose={() => {
          onClose?.()
          setOpen(false)
        }}
      >
        <h3 id="pop-title">Menu</h3>
        {empty ? <p>Nothing to press</p> : <button type="button">First item</button>}
      </Popover>
    </>
  )
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect
}

describe('Popover', () => {
  it('moves focus in on open; Escape closes it and returns focus to the anchor', async () => {
    // Arrange
    render(<PopoverHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const dialog = screen.getByRole('dialog', { name: 'Menu' })
    expect(screen.getByRole('button', { name: 'First item' })).toHaveFocus()

    // Act
    fireEvent.keyDown(window, { key: 'Escape' })

    // Assert
    expect(dialog).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus()
  })

  it('ignores other keys while open', async () => {
    // Arrange
    const onClose = vi.fn()
    render(<PopoverHarness onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))

    // Act
    fireEvent.keyDown(window, { key: 'a' })

    // Assert
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes on a pointer down outside, but not inside or on the anchor', async () => {
    // Arrange
    const onClose = vi.fn()
    render(<PopoverHarness onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))

    // Act + Assert
    fireEvent.pointerDown(screen.getByRole('button', { name: 'First item' }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open menu' }))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps focus where it is when the popover has nothing focusable', async () => {
    // Arrange
    render(<PopoverHarness empty />)
    const anchor = screen.getByRole('button', { name: 'Open menu' })

    // Act
    await userEvent.click(anchor)

    // Assert
    expect(screen.getByRole('dialog')).toHaveTextContent('Nothing to press')
    expect(anchor).toHaveFocus()
  })

  it.each<[Placement, { top: string; left: string }]>([
    ['below-end', { top: '68px', left: '200px' }],
    ['above-start', { top: '12px', left: '300px' }],
    ['above-center', { top: '12px', left: '250px' }],
  ])('positions itself %s of the anchor, kept inside the window', async (placement, expected) => {
    // Arrange
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(300, 20, 100, 40))
    render(<PopoverHarness placement={placement} />)

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))

    // Assert
    expect(screen.getByRole('dialog')).toHaveStyle(expected)
  })

  it('clamps to the right and top edges of the window', async () => {
    // Arrange
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(window.innerWidth - 20, 0, 100, 40))
    render(<PopoverHarness placement="above-start" />)

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))

    // Assert
    expect(screen.getByRole('dialog')).toHaveStyle({ left: `${window.innerWidth - 200 - 8}px`, top: '8px' })
  })
})

function TrapHarness({ active = true, locked = false, onEscape, empty = false }: { active?: boolean; locked?: boolean; onEscape: () => void; empty?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  useFocusTrap(root, active, onEscape, locked)
  return (
    <div ref={root} tabIndex={-1} aria-label="Trap" role="dialog">
      {empty ? null : (
        <>
          <button type="button">One</button>
          <button type="button" disabled>
            Off
          </button>
          <input aria-label="Two" />
          <button type="button">Three</button>
        </>
      )}
    </div>
  )
}

describe('useFocusTrap', () => {
  it('focuses the first control and wraps Tab and Shift+Tab at the ends', () => {
    // Arrange
    render(<TrapHarness onEscape={() => undefined} />)
    const one = screen.getByRole('button', { name: 'One' })
    const three = screen.getByRole('button', { name: 'Three' })
    expect(one).toHaveFocus()

    // Act + Assert
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(three).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(one).toHaveFocus()
  })

  it('leaves Tab alone in the middle of the trap', () => {
    // Arrange
    render(<TrapHarness onEscape={() => undefined} />)
    const two = screen.getByRole('textbox', { name: 'Two' })
    two.focus()

    // Act
    const notPrevented = fireEvent.keyDown(window, { key: 'Tab' })
    const notPreventedBack = fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })

    // Assert
    expect(notPrevented).toBe(true)
    expect(notPreventedBack).toBe(true)
    expect(two).toHaveFocus()
  })

  it('calls onEscape unless locked', () => {
    // Arrange
    const onEscape = vi.fn()
    const { rerender } = render(<TrapHarness onEscape={onEscape} />)

    // Act
    fireEvent.keyDown(window, { key: 'Escape' })
    rerender(<TrapHarness onEscape={onEscape} locked />)
    fireEvent.keyDown(window, { key: 'Escape' })

    // Assert
    expect(onEscape).toHaveBeenCalledOnce()
  })

  it('focuses the root itself when it has no controls, and Tab does nothing', () => {
    // Arrange
    render(<TrapHarness empty onEscape={() => undefined} />)
    const root = screen.getByRole('dialog', { name: 'Trap' })

    // Act
    const notPrevented = fireEvent.keyDown(window, { key: 'Tab' })

    // Assert
    expect(root).toHaveFocus()
    expect(notPrevented).toBe(true)
  })

  it('returns focus to the previously focused element when it deactivates', () => {
    // Arrange
    const outside = document.createElement('button')
    outside.textContent = 'Outside'
    document.body.append(outside)
    outside.focus()
    const { rerender } = render(<TrapHarness onEscape={() => undefined} />)
    expect(screen.getByRole('button', { name: 'One' })).toHaveFocus()

    // Act
    rerender(<TrapHarness active={false} onEscape={() => undefined} />)

    // Assert
    expect(outside).toHaveFocus()
    outside.remove()
  })

  it('does nothing while inactive', () => {
    // Arrange
    const onEscape = vi.fn()
    render(<TrapHarness active={false} onEscape={onEscape} />)

    // Act
    fireEvent.keyDown(window, { key: 'Escape' })

    // Assert
    expect(onEscape).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'One' })).not.toHaveFocus()
  })
})

describe('Toasts', () => {
  beforeEach(() => {
    resetStores()
    useView.setState({ toasts: [] })
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows toasts in a polite live region and dismisses them after 4 s', () => {
    // Arrange
    render(<Toasts />)
    act(() => {
      useView.getState().pushToast({ message: 'Saved.', tone: 'info' })
    })
    expect(screen.getByRole('status')).toHaveTextContent('Saved.')

    // Act
    act(() => {
      vi.advanceTimersByTime(3999)
    })
    const stillThere = screen.queryByText('Saved.') !== null
    act(() => {
      vi.advanceTimersByTime(1)
    })

    // Assert
    expect(stillThere).toBe(true)
    expect(screen.queryByText('Saved.')).toBeNull()
    expect(useView.getState().toasts).toEqual([])
  })

  it('a stop toast carries a warning icon and the dismiss button removes it', () => {
    // Arrange
    const { container } = render(<Toasts />)
    act(() => {
      useView.getState().pushToast({ message: 'Disk full.', tone: 'stop' })
    })
    expect(container.querySelector('.toast[data-tone="stop"] svg.icon')).not.toBeNull()

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    // Assert
    expect(screen.queryByText('Disk full.')).toBeNull()
  })

  it('an action button runs its action and dismisses the toast', () => {
    // Arrange
    const run = vi.fn()
    render(<Toasts />)
    act(() => {
      useView.getState().pushToast({ message: 'Moved.', tone: 'info', action: { label: 'Undo', run } })
    })

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    // Assert
    expect(run).toHaveBeenCalledOnce()
    expect(screen.queryByText('Moved.')).toBeNull()
  })
})

describe('Toasts: timing', () => {
  beforeEach(() => {
    resetStores()
    useView.setState({ toasts: [] })
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a hovered toast stays until the pointer leaves, then gets a fresh 4 s', () => {
    render(<Toasts />)
    act(() => {
      useView.getState().pushToast({ message: 'Aligned 1,204 of 3,012.', tone: 'info' })
    })
    const toast = screen.getByText('Aligned 1,204 of 3,012.').closest('.toast') as HTMLElement
    fireEvent.pointerEnter(toast)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.getByText('Aligned 1,204 of 3,012.')).toBeInTheDocument()
    fireEvent.pointerLeave(toast)
    act(() => {
      vi.advanceTimersByTime(3_999)
    })
    expect(screen.getByText('Aligned 1,204 of 3,012.')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByText('Aligned 1,204 of 3,012.')).toBeNull()
  })

  it('a focused toast stays until focus leaves it', () => {
    render(<Toasts />)
    act(() => {
      useView.getState().pushToast({ message: 'Day left out.', tone: 'info', action: { label: 'Undo', run: () => undefined } })
    })
    fireEvent.focus(screen.getByRole('button', { name: 'Undo' }))
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.getByText('Day left out.')).toBeInTheDocument()
    fireEvent.blur(screen.getByRole('button', { name: 'Undo' }))
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    expect(screen.queryByText('Day left out.')).toBeNull()
  })

  it('a new toast does not restart the timer of an older one', () => {
    render(<Toasts />)
    act(() => {
      useView.getState().pushToast({ message: 'First.', tone: 'info' })
    })
    act(() => {
      vi.advanceTimersByTime(3_000)
      useView.getState().pushToast({ message: 'Second.', tone: 'info' })
    })
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.queryByText('First.')).toBeNull()
    expect(screen.getByText('Second.')).toBeInTheDocument()
  })
})

describe('Escape layers', () => {
  it('Escape closes the newest layer only: a popover over a trap closes the popover', () => {
    const onTrapEscape = vi.fn()
    function Harness() {
      const root = useRef<HTMLDivElement>(null)
      useFocusTrap(root, true, onTrapEscape)
      return (
        <div ref={root}>
          <PopoverHarness />
        </div>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull()
    expect(onTrapEscape).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onTrapEscape).toHaveBeenCalledTimes(1)
  })

  it('a field with an unsaved edit takes the first Escape itself', () => {
    const onTrapEscape = vi.fn()
    function Harness() {
      const root = useRef<HTMLDivElement>(null)
      useFocusTrap(root, true, onTrapEscape)
      return (
        <div ref={root}>
          <input aria-label="Frames per second" data-dirty="true" defaultValue="12" />
        </div>
      )
    }
    render(<Harness />)
    fireEvent.keyDown(screen.getByLabelText('Frames per second'), { key: 'Escape' })
    expect(onTrapEscape).not.toHaveBeenCalled()
  })
})

describe('Notice', () => {
  it('a stop notice is an alert with a title and an action', () => {
    // Act
    render(
      <Notice tone="stop" title="The export stopped." action={<button type="button">Retry</button>}>
        The disk is full.
      </Notice>,
    )

    // Assert
    const alert = screen.getByRole('alert')
    expect(alert).toHaveClass('notice', 'notice-stop')
    expect(alert).toHaveTextContent('The export stopped.')
    expect(alert).toHaveTextContent('The disk is full.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('a safelight notice is a status without a title', () => {
    // Act
    const { container } = render(<Notice tone="safelight">Export stopped.</Notice>)

    // Assert
    const status = screen.getByRole('status')
    expect(status).toHaveClass('notice-safelight')
    expect(container.querySelector('strong')).toBeNull()
  })
})

// Critique round 4 (P1-3): popovers and toasts leave with a short exit; nothing waits for it.
describe('Exits', () => {
  afterEach(() => {
    removeFakeAnimations()
  })

  it('a closing popover fades out over 100 ms, inert, while focus and Escape have already moved on', async () => {
    // Arrange
    const fake = installFakeAnimations()
    const onTrapEscape = vi.fn()
    function Harness() {
      const root = useRef<HTMLDivElement>(null)
      useFocusTrap(root, true, onTrapEscape)
      return (
        <div ref={root}>
          <PopoverHarness />
        </div>
      )
    }
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const dialog = screen.getByRole('dialog', { name: 'Menu' })

    // Act
    fireEvent.keyDown(window, { key: 'Escape' })

    // Assert: still on screen and fading, but already inert, focus is back on the anchor,
    // and the next Escape reaches the layer under it.
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('inert')
    const exit = fake.calls.at(-1)
    expect(exit?.target).toBe(dialog)
    expect(exit?.keyframes).toEqual([{ opacity: 0 }])
    expect(exit?.options).toMatchObject({ duration: 100, fill: 'forwards' })
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onTrapEscape).toHaveBeenCalledOnce()

    // Act
    await act(async () => fake.finishAll())

    // Assert
    expect(dialog).not.toBeInTheDocument()
  })

  it('a dismissed toast slides down and fades over 150 ms before it goes; its timer no longer runs', async () => {
    // Arrange
    resetStores()
    useView.setState({ toasts: [] })
    const fake = installFakeAnimations()
    render(<Toasts />)
    act(() => {
      useView.getState().pushToast({ message: 'Moved.', tone: 'info' })
    })
    const toast = screen.getByText('Moved.').closest('.toast') as HTMLElement

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    // Assert
    expect(useView.getState().toasts).toEqual([])
    expect(toast).toBeInTheDocument()
    expect(toast).toHaveAttribute('inert')
    const exit = fake.calls.at(-1)
    expect(exit?.target).toBe(toast)
    expect(exit?.keyframes).toEqual([{ opacity: 0, transform: 'translateY(6px) scale(0.98)' }])
    expect(exit?.options).toMatchObject({ duration: 150 })

    // Act
    await act(async () => fake.finishAll())

    // Assert
    expect(toast).not.toBeInTheDocument()
  })

  it('a toast merged into an identical newer one is replaced without an exit', () => {
    resetStores()
    useView.setState({ toasts: [] })
    installFakeAnimations()
    render(<Toasts />)
    act(() => {
      useView.getState().pushToast({ message: 'Busy.', tone: 'info' })
    })
    act(() => {
      useView.getState().pushToast({ message: 'Busy.', tone: 'info' })
    })
    expect(screen.getAllByText('Busy.')).toHaveLength(1)
    expect(document.querySelector('.toast[inert]')).toBeNull()
  })
})

// Critique round 4, item 21: the toast's Undo was an 18 px text link.
describe('Toast action', () => {
  it('is a 24 px pill button of its own', () => {
    resetStores()
    useView.setState({ toasts: [] })
    render(<Toasts />)
    act(() => {
      useView.getState().pushToast({ message: 'Day left out.', tone: 'info', action: { label: 'Undo', run: () => undefined } })
    })
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveClass('toast-action')
    expect(screen.getByRole('button', { name: 'Undo' })).not.toHaveClass('btn-text')
  })
})
