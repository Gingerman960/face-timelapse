import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { FtMockApi } from '../../ipc/mock/install'
import { renderApp } from '../../test/renderApp'
import { useJobs } from '../../state/jobs'
import { useView } from '../../state/view'
import { classifyDrop } from './DropOverlay'

const REFERENCE_PATH = '/Users/demo/Pictures/Reference/IMG_20140815_142326.jpg'
/** Folders whose names look like files to an extension heuristic (M15). */
const DOTTED_FOLDER = '/Users/demo/Pictures/Selfies 2014.08'
const ARCHIVE_FOLDER = '/Users/demo/Pictures/Archive.2015'
/** What the backend answers when `set_source_folder` gets something that isn't a folder. */
const NOT_A_FOLDER = "That's a file, not a folder. Choose the folder that holds your daily photos."

function mock(): FtMockApi {
  const api = window.__FT_MOCK__
  if (!api) throw new Error('mock backend not installed')
  return api
}

async function dragEnter(paths: string[]): Promise<void> {
  await act(async () => {
    await mock().emitDragEnter(paths)
  })
}

async function drop(paths: string[]): Promise<void> {
  await act(async () => {
    await mock().emitDragDrop(paths)
  })
}

/** Spies on every command the fake backend receives. */
function spyCommands() {
  const spy = vi.spyOn(mock().backend, 'handle')
  return {
    names: () => spy.mock.calls.map(([cmd]) => cmd),
    args: (name: string) => spy.mock.calls.filter(([cmd]) => cmd === name).map(([, payload]) => payload),
  }
}

describe('classifyDrop', () => {
  it('takes the first image as the reference and the first other path as the library', () => {
    expect(classifyDrop(['/a/IMG_1.JPG', '/b/photos'])).toEqual({ image: '/a/IMG_1.JPG', folder: '/b/photos' })
    expect(classifyDrop(['/a/x.heic'])).toEqual({ image: '/a/x.heic', folder: null })
    expect(classifyDrop([DOTTED_FOLDER, REFERENCE_PATH])).toEqual({ image: REFERENCE_PATH, folder: DOTTED_FOLDER })
    expect(classifyDrop([])).toEqual({ image: null, folder: null })
  })

  // The backend decides what is a folder (ARCHITECTURE §8); the UI only recognises images.
  it('treats every non-image path as a folder candidate', () => {
    expect(classifyDrop([ARCHIVE_FOLDER])).toEqual({ image: null, folder: ARCHIVE_FOLDER })
    expect(classifyDrop(['/a/notes.txt'])).toEqual({ image: null, folder: '/a/notes.txt' })
  })
})

describe('Dropping files on the window', () => {
  // Regression (M15): "Selfies 2014.08" was rejected client-side as a file.
  it('sends a folder with a dot in its name to the backend and shows its answer', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })
    const commands = spyCommands()
    await dragEnter([DOTTED_FOLDER])
    expect(screen.getByText('Release to use this folder')).toBeInTheDocument()

    // Act
    await drop([DOTTED_FOLDER])

    // Assert
    await waitFor(() => expect(commands.args('set_source_folder')).toEqual([{ path: DOTTED_FOLDER }]))
    expect(await screen.findByText(NOT_A_FOLDER)).toBeInTheDocument()
    expect(screen.queryByText('Drop one photo of your face, or the folder of daily photos.')).toBeNull()
  })

  it('uses the first image as the reference and the first other path as the library', async () => {
    // Arrange
    await renderApp({ scenario: 'fresh' })
    const commands = spyCommands()

    // Act
    await drop([ARCHIVE_FOLDER, REFERENCE_PATH, DOTTED_FOLDER])

    // Assert
    await waitFor(() => expect(commands.args('set_source_folder')).toEqual([{ path: ARCHIVE_FOLDER }]))
    expect(commands.args('set_reference_photo')).toEqual([{ path: REFERENCE_PATH }])
    expect(await screen.findByRole('group', { name: /^Crop/ })).toBeInTheDocument()
  })

  it('still tries the folder when the photo is refused, and reports both', async () => {
    // Arrange
    await renderApp({ scenario: 'fresh', fail: { set_reference_photo: 'unsupportedFormat' } })
    const commands = spyCommands()

    // Act
    await drop([REFERENCE_PATH, ARCHIVE_FOLDER])

    // Assert
    await waitFor(() => expect(commands.names()).toEqual(expect.arrayContaining(['set_reference_photo', 'set_source_folder'])))
    expect(await screen.findByText(NOT_A_FOLDER)).toBeInTheDocument()
    expect(useView.getState().toasts).toHaveLength(2)
  })

  it('an empty drop explains what it accepts', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })

    // Act
    await drop([])

    // Assert
    expect(await screen.findByText('Drop one photo of your face, or the folder of daily photos.')).toBeInTheDocument()
  })

  it('is refused while another task runs', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })
    const commands = spyCommands()
    act(() => useJobs.setState({ activeJobId: 'job-1' }))

    // Act
    await drop([REFERENCE_PATH])

    // Assert
    expect(await screen.findByText(/^Another task is running/)).toBeInTheDocument()
    expect(commands.names()).not.toContain('set_reference_photo')
  })

  // Regression (M9): a drop behind the export sheet switched to Setup and changed the session.
  it('does nothing while a modal sheet is open', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    fireEvent.keyDown(window, { key: 'e' })
    await screen.findByRole('dialog', { name: 'Export timelapse' })
    const commands = spyCommands()

    // Act
    await dragEnter([REFERENCE_PATH])
    const overlay = screen.queryByRole('dialog', { name: 'Drop to add' })
    await drop([REFERENCE_PATH])

    // Assert
    expect(overlay).toBeNull()
    expect(commands.names()).not.toContain('set_reference_photo')
    expect(useView.getState().step).toBe('timelapse')
    expect(screen.getByRole('dialog', { name: 'Export timelapse' })).toBeInTheDocument()
  })
})
