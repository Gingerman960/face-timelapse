import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FolderInfo, Recents } from '../../ipc/contract'
import { SetupEmpty } from './SetupEmpty'

const FOLDER: FolderInfo = { path: '/Users/demo/Pictures/Daily selfies', name: 'Daily selfies', imageCount: 3593, analyzedCount: 0, unsupportedCount: 0 }
const NO_RECENTS: Recents = { references: [], folders: [] }

function renderEmpty(overrides: Partial<Parameters<typeof SetupEmpty>[0]> = {}) {
  const props = {
    folder: null,
    recents: NO_RECENTS,
    disabled: false,
    onChoosePhoto: vi.fn(),
    onChooseFolder: vi.fn(),
    onRecentPhoto: vi.fn(),
    onRecentFolder: vi.fn(),
    ...overrides,
  }
  render(<SetupEmpty {...props} />)
  return props
}

describe('SetupEmpty', () => {
  it('first run asks for a photo, then the folder, without recents', async () => {
    // Arrange
    const props = renderEmpty()

    // Act
    await userEvent.click(screen.getByRole('button', { name: /Choose photo…/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Choose folder…/ }))

    // Assert
    expect(screen.getByRole('heading', { name: 'Start with one photo of your face' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Then the folder of daily photos' })).toBeInTheDocument()
    expect(screen.getByText(/Subfolders are included\. Photos are read, never moved/)).toBeInTheDocument()
    expect(screen.queryByText('Recent')).toBeNull()
    expect(props.onChoosePhoto).toHaveBeenCalledOnce()
    expect(props.onChooseFolder).toHaveBeenCalledOnce()
  })

  it('names a chosen folder and offers another', () => {
    // Act
    renderEmpty({ folder: FOLDER })

    // Assert
    expect(screen.getByRole('heading', { name: 'Daily selfies' })).toBeInTheDocument()
    expect(screen.getByText('3,593 photos found, subfolders included.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Choose another folder…/ })).toBeInTheDocument()
  })

  it('lists up to three recent photos and folders by file name', async () => {
    // Arrange
    const recents: Recents = {
      references: ['/a/one.jpg', '/a/two.jpg', 'C:\\Photos\\three.jpg', '/a/four.jpg'],
      folders: ['/Users/demo/Pictures/Daily selfies/', '/Users/demo/Pictures/Old'],
    }
    const props = renderEmpty({ recents })

    // Act
    await userEvent.click(screen.getByRole('button', { name: /^three\.jpg/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Daily selfies/ }))

    // Assert
    expect(screen.getAllByText('Recent')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^four\.jpg/ })).toBeNull()
    expect(props.onRecentPhoto).toHaveBeenCalledWith('C:\\Photos\\three.jpg')
    expect(props.onRecentFolder).toHaveBeenCalledWith('/Users/demo/Pictures/Daily selfies/')
  })

  it('disables every action while a task runs', () => {
    // Act
    renderEmpty({ disabled: true, recents: { references: ['/a/one.jpg'], folders: ['/b'] } })

    // Assert
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
  })
})
