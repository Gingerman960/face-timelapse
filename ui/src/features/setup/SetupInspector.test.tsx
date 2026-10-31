import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AspectPreset, DayGroup, FolderInfo } from '../../ipc/contract'
import { makeReference } from '../../test/session'
import { ASPECTS, AspectTiles, FaceActions, LibrarySection } from './SetupInspector'

function Tiles({ onChange }: { onChange: (a: AspectPreset) => void }) {
  const [value, setValue] = useState<AspectPreset>('3:4')
  return (
    <AspectTiles
      value={value}
      disabled={false}
      onChange={(a) => {
        setValue(a)
        onChange(a)
      }}
    />
  )
}

describe('AspectTiles', () => {
  it('draws every preset at its proportions with a roving tab stop', () => {
    // Act
    render(<Tiles onChange={() => undefined} />)

    // Assert
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['1:1', '3:4', '4:5', '9:16', '4:3', '16:9', 'Free'])
    expect(screen.getByRole('radio', { name: '3:4' })).toHaveAttribute('tabindex', '0')
    const glyph = (name: string) => screen.getByRole('radio', { name }).querySelector('i') as HTMLElement
    expect(glyph('16:9').style.width).toBe('34px')
    expect(glyph('9:16').style.height).toBe('28px')
    expect(glyph('Free')).toHaveClass('free')
  })

  it('arrow keys step through the presets and wrap around', () => {
    // Arrange
    const onChange = vi.fn()
    render(<Tiles onChange={onChange} />)
    const group = screen.getByRole('radiogroup', { name: 'Output aspect ratio' })

    // Act
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    fireEvent.keyDown(group, { key: 'ArrowDown' })
    fireEvent.keyDown(group, { key: 'ArrowUp' })
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    const notPrevented = fireEvent.keyDown(group, { key: 'x' })

    // Assert
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['4:5', '9:16', '4:5', '3:4', '1:1', ASPECTS[ASPECTS.length - 1]])
    expect(notPrevented).toBe(true)
  })

  it('clicking a tile chooses it', async () => {
    // Arrange
    const onChange = vi.fn()
    render(<Tiles onChange={onChange} />)

    // Act
    await userEvent.click(screen.getByRole('radio', { name: 'Free' }))

    // Assert
    expect(onChange).toHaveBeenCalledWith('free')
    expect(screen.getByRole('radio', { name: 'Free' })).toHaveAttribute('aria-checked', 'true')
  })
})

describe('FaceActions', () => {
  function renderActions(reference = makeReference(), disabled = false) {
    const props = { onLevel: vi.fn(), onCenter: vi.fn(), onReset: vi.fn() }
    render(<FaceActions reference={reference} disabled={disabled} {...props} />)
    return props
  }

  it('offers to level tilted eyes and shows the signed angle', async () => {
    // Arrange
    const base = makeReference()
    const props = renderActions({ ...base, image: { ...base.image, autoRotationDeg: 2.34 } })

    // Act
    await userEvent.click(screen.getByRole('button', { name: /Level the eyes/ }))
    await userEvent.click(screen.getByRole('button', { name: /Centre the face/ }))
    await userEvent.click(screen.getByRole('button', { name: /Reset crop/ }))

    // Assert
    expect(screen.getByRole('button', { name: /Level the eyes/ })).toHaveTextContent('+2.3°')
    expect(props.onLevel).toHaveBeenCalledOnce()
    expect(props.onCenter).toHaveBeenCalledOnce()
    expect(props.onReset).toHaveBeenCalledOnce()
  })

  it('explains why levelling is off when the eyes are already level', () => {
    // Act
    renderActions()

    // Assert
    const level = screen.getByRole('button', { name: /Level the eyes/ })
    expect(level).toBeDisabled()
    expect(level).toHaveAttribute('title', 'The eyes are already level')
    expect(level).toHaveTextContent('−0.2°')
  })

  it('shows a dash without an automatic angle and cannot centre without a face', () => {
    // Arrange
    const base = makeReference()

    // Act
    renderActions({ ...base, image: { ...base.image, autoRotationDeg: null, face: null } })

    // Assert
    expect(screen.getByRole('button', { name: /Level the eyes/ })).toHaveTextContent('—')
    expect(screen.getByRole('button', { name: /Centre the face/ })).toBeDisabled()
  })

  it('shows no sign for an exactly level automatic angle', () => {
    // Arrange
    const base = makeReference()

    // Act
    renderActions({ ...base, image: { ...base.image, autoRotationDeg: 0 } }, true)

    // Assert
    expect(screen.getByRole('button', { name: /Level the eyes/ })).toHaveTextContent('0.0°')
    expect(screen.getByRole('button', { name: /Reset crop/ })).toBeDisabled()
  })
})

describe('LibrarySection', () => {
  const FOLDER: FolderInfo = { path: '/Users/demo/Pictures/Daily selfies', name: 'Daily selfies', imageCount: 3593, analyzedCount: 412, unsupportedCount: 2 }
  const DAYS = [{ dayKey: '2012-03-04' }, { dayKey: '2022-11-30' }] as DayGroup[]

  it('without a folder offers to choose one', async () => {
    // Arrange
    const onChoose = vi.fn()
    render(<LibrarySection folder={null} days={undefined} disabled={false} onChoose={onChoose} onForget={vi.fn()} />)

    // Act
    await userEvent.click(screen.getByRole('button', { name: /Choose folder…/ }))

    // Assert
    expect(onChoose).toHaveBeenCalledOnce()
  })

  it('lists the folder facts, skipped HEIC files and the date span', async () => {
    // Arrange
    const onChoose = vi.fn()
    render(<LibrarySection folder={FOLDER} days={DAYS} disabled={false} onChoose={onChoose} onForget={vi.fn()} />)

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Choose another folder' }))

    // Assert
    expect(onChoose).toHaveBeenCalledOnce()
    expect(screen.getByText('Daily selfies')).toBeInTheDocument()
    expect(screen.getByText('3,181')).toBeInTheDocument()
    expect(screen.getByText('HEIC, skipped')).toBeInTheDocument()
    expect(screen.getByText('Mar 2012 – Nov 2022')).toBeInTheDocument()
  })

  it('omits the HEIC and date rows when they do not apply', () => {
    // Act
    render(<LibrarySection folder={{ ...FOLDER, unsupportedCount: 0, analyzedCount: 0 }} days={[]} disabled={false} onChoose={vi.fn()} onForget={vi.fn()} />)

    // Assert
    expect(screen.queryByText('HEIC, skipped')).toBeNull()
    expect(screen.queryByText('Dates')).toBeNull()
    expect(screen.getByRole('button', { name: /Forget earlier scan results/ })).toBeDisabled()
  })

  it('confirms before forgetting earlier scan results', async () => {
    // Arrange
    const onForget = vi.fn(() => Promise.resolve())
    render(<LibrarySection folder={FOLDER} days={DAYS} disabled={false} onChoose={vi.fn()} onForget={onForget} />)
    const forget = screen.getByRole('button', { name: /Forget earlier scan results/ })

    // Act: open and keep.
    await userEvent.click(forget)
    expect(screen.getByRole('dialog', { name: 'Forget earlier scan results?' })).toHaveTextContent('The next scan reads all 3,593 photos again.')
    await userEvent.click(screen.getByRole('button', { name: 'Keep them' }))

    // Assert
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onForget).not.toHaveBeenCalled()

    // Act: open and forget.
    await userEvent.click(forget)
    await userEvent.click(screen.getByRole('button', { name: 'Forget' }))

    // Assert
    expect(onForget).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(forget).toHaveAttribute('aria-expanded', 'false')
  })
})
