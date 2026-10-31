import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChipGroup, Segmented, type SegmentOption } from './Segmented'

type Fruit = 'apple' | 'pear' | 'plum' | 'fig'

const FRUITS: ReadonlyArray<SegmentOption<Fruit>> = [
  { value: 'apple', label: 'Apple' },
  { value: 'pear', label: 'Pear', disabled: true, title: 'Out of season' },
  { value: 'plum', label: 'Plum' },
  { value: 'fig', label: 'Fig' },
]

function Controlled({ initial = 'apple', options = FRUITS, onChange }: { initial?: Fruit; options?: ReadonlyArray<SegmentOption<Fruit>>; onChange?: (v: Fruit) => void }) {
  const [value, setValue] = useState<Fruit>(initial)
  return (
    <Segmented<Fruit>
      label="Fruit"
      className="extra"
      value={value}
      options={options}
      onChange={(v) => {
        setValue(v)
        onChange?.(v)
      }}
    />
  )
}

const radio = (name: string) => screen.getByRole('radio', { name })

describe('Segmented', () => {
  it('renders a labelled radio group with a roving tab stop on the checked option', () => {
    // Act
    render(<Controlled />)

    // Assert
    const group = screen.getByRole('radiogroup', { name: 'Fruit' })
    expect(group).toHaveClass('segmented', 'extra')
    expect(radio('Apple')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Apple')).toHaveAttribute('tabindex', '0')
    expect(radio('Plum')).toHaveAttribute('tabindex', '-1')
    expect(radio('Pear')).toBeDisabled()
    expect(radio('Pear')).toHaveAttribute('title', 'Out of season')
  })

  it('arrow keys move the selection and focus, skipping disabled options and wrapping', () => {
    // Arrange
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    radio('Apple').focus()

    // Act + Assert
    fireEvent.keyDown(radio('Apple'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('plum')
    expect(radio('Plum')).toHaveFocus()
    expect(radio('Plum')).toHaveAttribute('aria-checked', 'true')

    fireEvent.keyDown(radio('Plum'), { key: 'ArrowDown' })
    expect(radio('Fig')).toHaveFocus()

    fireEvent.keyDown(radio('Fig'), { key: 'ArrowRight' })
    expect(radio('Apple')).toHaveFocus()

    fireEvent.keyDown(radio('Apple'), { key: 'ArrowLeft' })
    expect(radio('Fig')).toHaveFocus()

    fireEvent.keyDown(radio('Fig'), { key: 'ArrowUp' })
    expect(radio('Plum')).toHaveFocus()
  })

  it('Home and End jump to the first and last enabled options', () => {
    // Arrange
    const onChange = vi.fn()
    render(<Controlled initial="plum" onChange={onChange} />)

    // Act
    fireEvent.keyDown(radio('Plum'), { key: 'End' })
    const afterEnd = onChange.mock.lastCall?.[0]
    fireEvent.keyDown(radio('Fig'), { key: 'Home' })

    // Assert
    expect(afterEnd).toBe('fig')
    expect(onChange).toHaveBeenLastCalledWith('apple')
    expect(radio('Apple')).toHaveFocus()
  })

  it('ignores other keys and lets them through', () => {
    // Arrange
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    // Act
    const notPrevented = fireEvent.keyDown(radio('Apple'), { key: 'Enter' })

    // Assert
    expect(notPrevented).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does nothing on arrows when every option is disabled', () => {
    // Arrange
    const onChange = vi.fn()
    const disabled = FRUITS.map((o) => ({ ...o, disabled: true }))
    render(<Controlled options={disabled} onChange={onChange} />)

    // Act
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' })

    // Assert
    expect(onChange).not.toHaveBeenCalled()
  })

  // Regression (L3): a value outside the options (e.g. a 29.56 fps pace) left no button in the tab order.
  it('keeps the first enabled option tabbable when the value matches none, and checks nothing', () => {
    // Act
    render(<Segmented<string> label="Pace" value="29.56" options={[{ value: '10', label: '10', disabled: true }, { value: '24', label: '24' }, { value: '30', label: '30' }]} onChange={() => undefined} />)

    // Assert
    expect(radio('24')).toHaveAttribute('tabindex', '0')
    expect(radio('30')).toHaveAttribute('tabindex', '-1')
    expect(screen.queryByRole('radio', { checked: true })).toBeNull()
  })

  it('arrows from an unmatched value go to the first or the last enabled option', () => {
    // Arrange
    const onChange = vi.fn()
    const options: ReadonlyArray<SegmentOption<string>> = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C', disabled: true }]
    render(<Segmented<string> label="Letters" value="z" options={options} onChange={onChange} />)

    // Act
    fireEvent.keyDown(radio('A'), { key: 'ArrowRight' })
    fireEvent.keyDown(radio('A'), { key: 'ArrowLeft' })

    // Assert
    expect(onChange.mock.calls).toEqual([['a'], ['b']])
  })

  it('a disabled checked option hands the tab stop to the first enabled one', () => {
    // Act
    render(<Controlled initial="pear" />)

    // Assert
    expect(radio('Pear')).toHaveAttribute('tabindex', '-1')
    expect(radio('Apple')).toHaveAttribute('tabindex', '0')
  })

  it('clicking an option selects it', async () => {
    // Arrange
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    // Act
    await userEvent.click(radio('Fig'))

    // Assert
    expect(onChange).toHaveBeenCalledWith('fig')
    expect(radio('Fig')).toHaveAttribute('aria-checked', 'true')
  })
})

describe('ChipGroup', () => {
  it('renders chips as radios and reports clicks on enabled ones', async () => {
    // Arrange
    const onChange = vi.fn()
    render(<ChipGroup<Fruit> label="Chips" value="plum" options={FRUITS} onChange={onChange} />)

    // Act
    await userEvent.click(radio('Fig'))
    await userEvent.click(radio('Pear'))

    // Assert
    expect(screen.getByRole('radiogroup', { name: 'Chips' })).toHaveClass('chips')
    expect(radio('Plum')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Pear')).toHaveAttribute('title', 'Out of season')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('fig')
  })
})
