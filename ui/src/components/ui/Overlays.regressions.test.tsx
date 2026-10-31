// Regression from UI review #1 (M8): an open popover must not steal focus back
// to its first control whenever its parent re-renders with a new onClose.
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Popover } from './Overlays'

function Harness() {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [tick, setTick] = useState(0)
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen(true)}>
        Size
      </button>
      <button type="button" onClick={() => setTick((t) => t + 1)}>
        Re-render {tick}
      </button>
      {/* An inline arrow: a new onClose on every render, like the real callers. */}
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} labelledBy="t" width={200}>
        <h3 id="t">Caption size</h3>
        <button type="button">S</button>
        <button type="button">M</button>
        <button type="button">L</button>
      </Popover>
    </>
  )
}

describe('Popover focus (M8)', () => {
  it('keeps focus where the user put it when the parent re-renders', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Size' }))
    expect(screen.getByRole('button', { name: 'S' })).toHaveFocus()
    screen.getByRole('button', { name: 'L' }).focus()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Re-render/ }))
    })
    screen.getByRole('button', { name: 'L' }).focus()
    act(() => {
      screen.getByRole('button', { name: /^Re-render/ }).click()
    })

    expect(screen.getByRole('dialog', { name: 'Caption size' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'S' })).not.toHaveFocus()
  })
})
