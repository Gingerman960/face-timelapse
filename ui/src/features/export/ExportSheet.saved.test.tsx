// Critique round 4 (P1-3, items 21 and 25): encoding fits its content, Saved is a diptych with
// Play, the sheet morphs between its phases and leaves with an exit.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { installFakeAnimations, removeFakeAnimations } from '../../components/ui/fakeAnimations'
import { formatDayLong } from '../../lib/dates'
import { DEFAULT_MESSAGES } from '../../ipc/mock/errors'
import { renderApp } from '../../test/renderApp'
import { useJobs } from '../../state/jobs'
import { usePlayer } from '../../state/player'
import { useView } from '../../state/view'
import { exportButton, mod, openSheet } from './exportSheetTesting'

// Critique round 4 (P1-3): the last impression of a decade of photos. Encoding fits its
// content (it was a 60 % empty sheet); Saved is the decade as a diptych, with Play.
describe('Export sheet: encoding (critique round 4)', () => {
  it('counts at heading size with only its numerals in the data font, beside the frame, over a meter across the sheet', async () => {
    // Arrange
    const { ui, backend } = await openSheet()
    backend.configure({ speed: 'fast' })

    // Act
    await userEvent.click(exportButton(ui))

    // Assert: the count is in days (critique round 5, P1-7: "Encoding 39 of 10,777 frames" sat
    // under "3,573 frames"); the encoder's frames are named on the data line.
    const counter = await ui.findByText(/^Encoding/, { selector: '.enc-num' })
    expect(counter).toHaveTextContent(/^Encoding day [\d,]+ of [\d,]+$/)
    expect([...counter.querySelectorAll('.digits')].map((d) => d.textContent)).toEqual([expect.stringMatching(/^[\d,]+$/), expect.stringMatching(/^[\d,]+$/)])
    const progress = counter.closest('.sheet-progress') as HTMLElement
    const data = progress.querySelector('.enc-copy .data-line') as HTMLElement
    expect(data).toHaveTextContent(/^\d+:\d\d\.\d of video · [\d.]+ fps · /)
    expect([...data.querySelectorAll('.mono')].map((v) => v.textContent)).toEqual([expect.stringMatching(/^\d+:\d\d\.\d$/), expect.stringMatching(/^[\d.]+$/)])
    expect(progress.querySelector(':scope > .enc-frame img')).not.toBeNull()
    expect(within(progress).getByRole('progressbar', { name: 'Export progress' }).parentElement).toBe(progress)

    // Clean up
    await userEvent.click(ui.getByRole('button', { name: /Stop/ }))
    await ui.findByText('Export stopped. Nothing half-written was left behind.', {}, { timeout: 3000 })
  })

  it('keeps focus in the sheet when a phase takes away the focused button', async () => {
    const { ui, sheet } = await openSheet()
    exportButton(ui).focus()
    fireEvent.keyDown(sheet, { key: 'Enter', ...mod })
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
    expect(sheet).toHaveFocus()
  })
})

describe('Export sheet: saved as a diptych (critique round 4)', () => {
  it('shows the first and last days, their dates in edge print, and ticks them with the pen', async () => {
    // Arrange
    const { ui, sheet, frames } = await openSheet()
    const first = frames[0]
    const last = frames.at(-1)

    // Act
    fireEvent.keyDown(sheet, { key: 'Enter', ...mod })

    // Assert
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
    const diptych = sheet.querySelector('.diptych') as HTMLElement
    const prints = within(diptych).getAllByRole('img')
    expect(prints.map((img) => img.getAttribute('alt'))).toEqual([`First day, ${formatDayLong(first?.dayKey ?? '')}`, `Last day, ${formatDayLong(last?.dayKey ?? '')}`])
    expect(prints[0]?.getAttribute('src')).toContain(first?.photoId)
    expect(prints[1]?.getAttribute('src')).toContain(last?.photoId)
    expect([...diptych.querySelectorAll('.edge')].map((e) => e.getAttribute('data-day'))).toEqual([first?.dayKey.replaceAll('-', '·'), '▸', last?.dayKey.replaceAll('-', '·')])
    expect([...diptych.querySelectorAll('.edge')].every((e) => e.getAttribute('aria-hidden') === 'true')).toBe(true)
  })

  // Critique round 5, P2-11: the tick drew on a fixed 280 ms timer, often onto unexposed prints,
  // and the copy came before the pictures.
  it('develops the prints one after the other, ticks them only once both are in, then shows the facts', async () => {
    // Arrange
    const { ui, sheet } = await openSheet()
    fireEvent.keyDown(sheet, { key: 'Enter', ...mod })
    await ui.findByRole('heading', { name: 'Saved' })
    const diptych = sheet.querySelector('.diptych') as HTMLElement
    const [a, b] = within(diptych).getAllByRole('img') as [HTMLElement, HTMLElement]
    const printOf = (img: HTMLElement) => img.closest('.export-print') as HTMLElement
    const copy = sheet.querySelector('.saved-copy') as HTMLElement

    // Assert: unexposed film, no tick and no facts while the images are out.
    await new Promise((r) => setTimeout(r, 400))
    expect(printOf(a)).toHaveAttribute('data-film', 'latent')
    expect(printOf(b)).toHaveAttribute('data-film', 'latent')
    expect(diptych.querySelector('svg.mark.dip-tick')).toBeNull()
    expect(copy).not.toHaveAttribute('data-told')

    // Act: the first image lands.
    fireEvent.load(a)

    // Assert: the first print develops; the last waits for its image, and so does the pen.
    await waitFor(() => expect(printOf(a)).toHaveAttribute('data-film', 'fresh'))
    expect(printOf(b)).toHaveAttribute('data-film', 'latent')
    await new Promise((r) => setTimeout(r, 400))
    expect(diptych.querySelector('svg.mark.dip-tick')).toBeNull()

    // Act: the last image lands.
    fireEvent.load(b)

    // Assert: the last print develops, the pen ticks the pair, then the facts come.
    await waitFor(() => expect(printOf(b)).toHaveAttribute('data-film', 'fresh'))
    await waitFor(() => expect(diptych.querySelector('svg.mark.dip-tick')).not.toBeNull())
    await waitFor(() => expect(copy).toHaveAttribute('data-told'))
    expect(ui.getByRole('heading', { name: 'Saved' })).toBeInTheDocument()
  })

  // Contract v1.7 (open_path): Play opens the saved video in the default player; watching it
  // here stays one click away, on the diptych (UI review 5, M1).
  it('Play ⌘↩ is the plate: it opens the saved video in its default app and closes the sheet', async () => {
    // Arrange
    const { ui, sheet, backend } = await openSheet()
    fireEvent.keyDown(sheet, { key: 'Enter', ...mod })
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
    const saved = useJobs.getState().exportVideo.summary?.path
    const play = ui.getByRole('button', { name: 'Play' })
    expect(play).toHaveClass('btn-plate')
    expect(play).toHaveAttribute('title', 'Open the video in your default player')
    expect(play.querySelector('kbd')).toHaveTextContent('⌘↩')
    expect(ui.getByRole('button', { name: 'Done' })).toHaveClass('btn-quiet')
    expect(ui.getByRole('button', { name: /Show in Finder/ })).toHaveClass('btn-quiet')
    const calls = vi.spyOn(backend, 'handle')

    // Act: once saved, ⌘↩ is Play.
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export timelapse' })).toBeNull())
    expect(calls).toHaveBeenCalledWith('open_path', { path: saved })
    expect(usePlayer.getState().playing).toBe(false)
  })

  it('a video the system can’t open stays said, and the sheet stays', async () => {
    const { ui, sheet, backend } = await openSheet()
    fireEvent.keyDown(sheet, { key: 'Enter', ...mod })
    await ui.findByRole('heading', { name: 'Saved' })
    backend.configure({ fail: { open_path: 'notFound' } })
    await userEvent.click(ui.getByRole('button', { name: 'Play' }))
    expect(await screen.findByText(DEFAULT_MESSAGES.notFound)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Export timelapse' })).toBeInTheDocument()
  })

  // Critique round 5, P2-11: the in-sheet cue is named "Watch here"; Play opens the file.
  it('the diptych is "Watch here": it closes the sheet and plays from the first day', async () => {
    // Arrange
    const { ui, sheet } = await openSheet()
    act(() => usePlayer.setState({ index: 40, settled: 40 }))
    fireEvent.keyDown(sheet, { key: 'Enter', ...mod })
    await ui.findByRole('heading', { name: 'Saved' })
    const watch = ui.getByRole('button', { name: 'Watch here' })
    expect(watch.querySelector('.diptych-cue')).toHaveTextContent('Watch here')

    // Act
    await userEvent.click(watch)

    // Assert
    expect(screen.queryByRole('dialog', { name: 'Export timelapse' })).toBeNull()
    expect(usePlayer.getState()).toMatchObject({ index: 0, settled: 0, playing: true, rate: 1 })
    expect(useJobs.getState().exportVideo.summary).toBeNull()
  })

  it('after frames, there is nothing to play: Done is the plate and ⌘↩ closes', async () => {
    // Arrange
    const { ui } = await openSheet()
    await userEvent.click(ui.getByRole('radio', { name: 'Frames' }))
    await userEvent.click(exportButton(ui))
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()

    // Assert
    expect(ui.queryByRole('button', { name: 'Play' })).toBeNull()
    expect(ui.getByRole('button', { name: 'Done' })).toHaveClass('btn-plate')

    // Act
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert
    expect(screen.queryByRole('dialog', { name: 'Export timelapse' })).toBeNull()
    expect(usePlayer.getState().playing).toBe(false)
  })
})

describe('Export sheet: exits and morphs (critique round 4)', () => {
  afterEach(() => {
    removeFakeAnimations()
  })

  it('Cancel plays the sheet out over 200 ms; focus is back at once, and the sheet goes when its exit ends', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    const fake = installFakeAnimations()
    const trigger = screen.getByRole('button', { name: /^Export…/ })
    trigger.focus()
    fireEvent.keyDown(window, { key: 'e' })
    const sheet = await screen.findByRole('dialog', { name: 'Export timelapse' })

    // Act
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))

    // Assert: the sheet lifts away, inert; focus did not wait for it.
    expect(sheet).toBeInTheDocument()
    expect(sheet.closest('.sheet-layer')).toHaveAttribute('inert')
    expect(trigger).toHaveFocus()
    const frameExit = fake.calls.find((c) => c.target.classList.contains('sheet-frame'))
    expect(frameExit?.keyframes).toEqual([{ opacity: 0, transform: 'translateY(-10px) scale(0.985)' }])
    expect(frameExit?.options).toMatchObject({ duration: 200, fill: 'forwards' })
    expect(fake.calls.find((c) => c.target.classList.contains('sheet-scrim'))?.keyframes).toEqual([{ opacity: 0 }])
    expect(useView.getState().exportOpen).toBe(true)

    // Act
    await act(async () => fake.finishAll())

    // Assert
    expect(sheet).not.toBeInTheDocument()
    expect(useView.getState().exportOpen).toBe(false)
  })

  it('a closing sheet takes no more actions', async () => {
    const { ui } = await openSheet()
    installFakeAnimations()
    await userEvent.click(ui.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(window, { key: 'Enter', ...mod })
    expect(useJobs.getState().activeJobId).toBeNull()
    expect(ui.queryByRole('heading', { name: 'Saved' })).toBeNull()
  })

  it('morphs into the next phase: the new content fades in over a fading copy of the old', async () => {
    // Arrange
    const { ui, backend, sheet } = await openSheet()
    backend.configure({ speed: 'fast' })
    const fake = installFakeAnimations()

    // Act
    await userEvent.click(exportButton(ui))
    await ui.findByText(/^Encoding/, { selector: '.enc-num' })

    // Assert (jsdom has no layout, so both phases measure the same: only the cross-fade runs).
    const phase = sheet.querySelector(':scope > .sheet-phase') as HTMLElement
    expect(fake.calls.find((c) => c.target === phase)?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
    const ghost = sheet.querySelector('.sheet-ghost') as HTMLElement
    expect(ghost).toHaveAttribute('aria-hidden', 'true')
    expect(ghost).toHaveTextContent(/Export…/)
    await act(async () => fake.finishAll())
    expect(ghost).toBeEmptyDOMElement()

    // Clean up
    await userEvent.click(ui.getByRole('button', { name: /Stop/ }))
    await ui.findByText('Export stopped. Nothing half-written was left behind.', {}, { timeout: 3000 })
  })
})
