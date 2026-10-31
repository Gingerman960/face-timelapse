import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Facts, Meter, NumberField, SwitchRow, ToggleChip } from './Controls'

describe('NumberField', () => {
  const field = () => screen.getByRole('textbox', { name: 'Speed' })

  it('commits the typed text on Enter', async () => {
    // Arrange
    const onCommit = vi.fn()
    render(<NumberField label="Speed" value="30" unit="fps" width={60} onCommit={onCommit} />)

    // Act
    await userEvent.clear(field())
    await userEvent.type(field(), '24{Enter}')

    // Assert
    expect(onCommit).toHaveBeenCalledWith('24')
    expect(field()).toHaveStyle({ width: '60px' })
    expect(screen.getByText('fps')).toHaveAttribute('aria-hidden', 'true')
  })

  it('commits on blur only when the text changed', () => {
    // Arrange
    const onCommit = vi.fn()
    render(<NumberField label="Speed" value="30" unit="fps" onCommit={onCommit} />)

    // Act
    fireEvent.blur(field())
    fireEvent.change(field(), { target: { value: '12' } })
    fireEvent.blur(field())

    // Assert
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('12')
  })

  it('Escape restores the committed value without committing', () => {
    // Arrange
    const onCommit = vi.fn()
    render(<NumberField label="Speed" value="30" unit="fps" onCommit={onCommit} />)
    fireEvent.change(field(), { target: { value: '99' } })

    // Act
    fireEvent.keyDown(field(), { key: 'Escape' })

    // Assert
    expect(field()).toHaveValue('30')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('keeps keystrokes away from window shortcuts', () => {
    // Arrange
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    render(<NumberField label="Speed" value="30" unit="fps" onCommit={() => undefined} />)

    // Act
    fireEvent.keyDown(field(), { key: 'k' })
    window.removeEventListener('keydown', onWindowKey)

    // Assert
    expect(onWindowKey).not.toHaveBeenCalled()
  })

  it('follows a new value from its parent and marks invalid input', () => {
    // Arrange
    const { rerender, container } = render(<NumberField label="Speed" value="30" unit="fps" onCommit={() => undefined} />)
    fireEvent.change(field(), { target: { value: '7' } })

    // Act
    rerender(<NumberField label="Speed" value="60" unit="fps" invalid disabled onCommit={() => undefined} />)

    // Assert
    expect(field()).toHaveValue('60')
    expect(field()).toBeDisabled()
    expect(container.querySelector('label.num')).toHaveAttribute('data-invalid', 'true')
  })
})

describe('Meter', () => {
  it('exposes progress and clamps the bar fill', () => {
    // Act
    render(
      <>
        <Meter label="Half" value={4.6} max={10} className="slim" />
        <Meter label="Over" value={30} max={10} />
        <Meter label="Empty" value={3} max={0} />
        <Meter label="Default max" value={0.25} />
      </>,
    )

    // Assert
    const half = screen.getByRole('progressbar', { name: 'Half' })
    expect(half).toHaveAttribute('aria-valuenow', '5')
    expect(half).toHaveAttribute('aria-valuemax', '10')
    expect(half).toHaveClass('meter', 'slim')
    const fill = (name: string) => (screen.getByRole('progressbar', { name }).firstElementChild as HTMLElement).style.getPropertyValue('--p')
    expect(Number(fill('Half'))).toBeCloseTo(0.46)
    expect(fill('Over')).toBe('1')
    expect(fill('Empty')).toBe('0')
    expect(fill('Default max')).toBe('0.25')
  })
})

describe('Facts', () => {
  it('renders a definition list, mono unless a row opts out', () => {
    // Act
    const { container } = render(
      <Facts
        className="tight"
        rows={[
          { label: 'Photos', value: '3,593' },
          { label: 'Folder', value: 'Daily selfies', mono: false },
        ]}
      />,
    )

    // Assert
    expect(container.querySelector('dl')).toHaveClass('facts', 'tight')
    expect(screen.getByText('Photos').tagName).toBe('DT')
    expect(screen.getByText('3,593')).toHaveClass('mono')
    expect(screen.getByText('Daily selfies')).not.toHaveClass('mono')
  })
})

describe('ToggleChip', () => {
  it('mirrors its state in aria-pressed and reports the flipped value', async () => {
    // Arrange
    const onPressedChange = vi.fn()
    render(
      <ToggleChip pressed={false} onPressedChange={onPressedChange} kbd="O">
        Onion
      </ToggleChip>,
    )
    const chip = screen.getByRole('button', { name: /Onion/ })

    // Act
    await userEvent.click(chip)

    // Assert
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    expect(onPressedChange).toHaveBeenCalledWith(true)
    expect(chip.querySelector('kbd')).toHaveTextContent('O')
  })
})

describe('SwitchRow', () => {
  it('is a labelled switch described by its help text', async () => {
    // Arrange
    const onChange = vi.fn()
    render(<SwitchRow label="Loop" help="Start over at the end" checked={false} onChange={onChange} />)
    const sw = screen.getByRole('switch', { name: /Loop/ })

    // Act
    await userEvent.click(sw)

    // Assert
    expect(sw).toHaveAccessibleDescription('Start over at the end')
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('has no description without help', () => {
    // Act
    render(<SwitchRow label="Loop" checked disabled onChange={() => undefined} />)

    // Assert
    const sw = screen.getByRole('switch', { name: 'Loop' })
    expect(sw).not.toHaveAttribute('aria-describedby')
    expect(sw).toBeChecked()
    expect(sw).toBeDisabled()
  })
})
