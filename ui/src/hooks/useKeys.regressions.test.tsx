// Regression from UI review #1 (M10): screen shortcuts must not steal keys
// from a focused range, checkbox or anything inside a popover, or a keyboard
// user can't adjust the onion Opacity / look Strength or toggle "Difference".
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useKeydown } from './useKeys'

function Screen({ onKey }: { onKey: (e: KeyboardEvent) => void }) {
  useKeydown(onKey)
  return (
    <>
      <input type="range" aria-label="Opacity" min={0} max={1} step={0.1} defaultValue={0.5} />
      <input type="checkbox" aria-label="Difference" />
      <div className="popover" role="dialog" aria-label="Onion skin">
        <button type="button">Previous day</button>
      </div>
      <button type="button">Elsewhere</button>
    </>
  )
}

describe('useKeydown and focused controls (M10)', () => {
  it('ignores keys aimed at a range input or a checkbox', () => {
    const onKey = vi.fn()
    render(<Screen onKey={onKey} />)
    fireEvent.keyDown(screen.getByLabelText('Opacity'), { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByLabelText('Difference'), { key: ' ' })
    expect(onKey).not.toHaveBeenCalled()
  })

  it('ignores keys inside a popover', () => {
    const onKey = vi.fn()
    render(<Screen onKey={onKey} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Previous day' }), { key: 'ArrowLeft' })
    expect(onKey).not.toHaveBeenCalled()
  })

  it('still handles screen keys from other places', () => {
    const onKey = vi.fn()
    render(<Screen onKey={onKey} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Elsewhere' }), { key: 'ArrowLeft' })
    fireEvent.keyDown(document.body, { key: 'o' })
    expect(onKey).toHaveBeenCalledTimes(2)
  })
})
