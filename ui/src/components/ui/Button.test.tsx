import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IconButton, PlateButton, QuietButton, StopButton, TextButton, cx } from './Button'

describe('cx', () => {
  it('joins truthy class names', () => {
    expect(cx('a', false, undefined, 'b')).toBe('a b')
  })
})

describe('buttons', () => {
  it('PlateButton is a non-submitting plate with an optional wide modifier and key cap', async () => {
    // Arrange
    const onClick = vi.fn()
    const ref = createRef<HTMLButtonElement>()
    render(
      <PlateButton ref={ref} wide kbd="⌘↩" className="x" icon={<svg data-testid="icon" />} onClick={onClick}>
        Export…
      </PlateButton>,
    )
    const button = screen.getByRole('button', { name: /Export…/ })

    // Act
    await userEvent.click(button)

    // Assert
    expect(onClick).toHaveBeenCalledOnce()
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveClass('btn-plate', 'wide', 'x')
    expect(button.querySelector('kbd')).toHaveTextContent('⌘↩')
    expect(screen.getByTestId('icon')).toBeInTheDocument()
    expect(ref.current).toBe(button)
  })

  it('PlateButton without kbd or wide renders just its label', () => {
    // Act
    render(<PlateButton type="submit">Go</PlateButton>)

    // Assert
    const button = screen.getByRole('button', { name: 'Go' })
    expect(button).toHaveAttribute('type', 'submit')
    expect(button).not.toHaveClass('wide')
    expect(button.querySelector('kbd')).toBeNull()
  })

  it('QuietButton forwards its ref and shows a key cap when given', () => {
    // Arrange
    const ref = createRef<HTMLButtonElement>()

    // Act
    render(
      <>
        <QuietButton ref={ref} kbd="⌘.">
          Stop
        </QuietButton>
        <QuietButton>Cancel</QuietButton>
      </>,
    )

    // Assert
    expect(ref.current).toHaveClass('btn-quiet')
    expect(ref.current?.querySelector('kbd')).toHaveTextContent('⌘.')
    expect(screen.getByRole('button', { name: 'Cancel' }).querySelector('kbd')).toBeNull()
  })

  it('StopButton is destructive and may carry a key cap', () => {
    // Act
    render(
      <>
        <StopButton kbd="⌫" className="y">
          Forget
        </StopButton>
        <StopButton>Delete</StopButton>
      </>,
    )

    // Assert
    const forget = screen.getByRole('button', { name: /Forget/ })
    expect(forget).toHaveClass('btn-stop', 'y')
    expect(forget.querySelector('kbd')).toHaveTextContent('⌫')
    expect(screen.getByRole('button', { name: 'Delete' }).querySelector('kbd')).toBeNull()
  })

  it('IconButton is named by its label, which is also the default tooltip', () => {
    // Act
    render(
      <>
        <IconButton label="Dismiss" small>
          <svg />
        </IconButton>
        <IconButton label="Settings" title="Open settings">
          <svg />
        </IconButton>
      </>,
    )

    // Assert
    const dismiss = screen.getByRole('button', { name: 'Dismiss' })
    expect(dismiss).toHaveAttribute('title', 'Dismiss')
    expect(dismiss).toHaveClass('btn-icon', 'sm')
    const settings = screen.getByRole('button', { name: 'Settings' })
    expect(settings).toHaveAttribute('title', 'Open settings')
    expect(settings).not.toHaveClass('sm')
  })

  it('TextButton is an underlined text action', () => {
    // Act
    render(<TextButton className="z">Undo</TextButton>)

    // Assert
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveClass('btn-text', 'z')
  })
})
