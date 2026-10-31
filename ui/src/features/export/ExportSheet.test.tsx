import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FramesView, SessionSnapshot } from '../../ipc/contract'
import { DEFAULT_MESSAGES } from '../../ipc/mock/errors'
import { EXPORT_FOLDER } from '../../ipc/mock/mockFs'
import { strftime } from '../../lib/dates'
import { outputSize } from '../../lib/video'
import { withRetryParam } from '../../components/ui/RetryImg'
import { renderApp } from '../../test/renderApp'
import { queryClient, queryKeys } from '../../state/queries'
import { useJobs } from '../../state/jobs'
import { usePlayer } from '../../state/player'
import { useView } from '../../state/view'
import { commit, exportButton, fact, facts, field, line, mod, moreOptions, openSheet, savedLead } from './exportSheetTesting'

describe('Export sheet: timing', () => {
  it('a duration drives the pace in days a second, and a too-short video warns and blocks the export', async () => {
    // Arrange: the aligned scenario cuts between days, so a day is one frame.
    const { ui, frames, session } = await openSheet()
    const holds = session.video.holdFirstSecs + session.video.holdLastSecs
    const paceFor = (secs: number) => String(Number((frames.length / (secs - holds)).toFixed(2)))

    // Act
    await commit(field(ui, 'Duration'), '1:00')

    // Assert
    await waitFor(() => expect(field(ui, 'Days a second')).toHaveValue(paceFor(60)))
    expect(ui.getByText('Pick between 1 and 60 days a second.')).toHaveClass('warn')
    expect(exportButton(ui)).toBeDisabled()
    expect(exportButton(ui)).toHaveAttribute('title', 'Check the highlighted settings.')

    // Act: a longer video is fine again.
    await commit(field(ui, 'Duration'), '1:50')

    // Assert
    await waitFor(() => expect(field(ui, 'Days a second')).toHaveValue(paceFor(110)))
    expect(ui.getByText(/Change one and the other follows/)).not.toHaveClass('warn')
    expect(exportButton(ui)).toBeEnabled()
  })

  // Regression (M14): in fps mode the length is not limited, so it is information, not an error.
  it('a slow pace shows the actual length as information and still exports', async () => {
    // Arrange
    const { ui, frames, session } = await openSheet()
    const secs = frames.length / 10 + session.video.holdFirstSecs + session.video.holdLastSecs

    // Act
    await commit(field(ui, 'Days a second'), '10')

    // Assert
    const length = `${Math.floor(secs / 60)}:${(secs % 60).toFixed(1).padStart(4, '0')}`
    await waitFor(() => expect(field(ui, 'Duration')).toHaveValue(length))
    const help = ui.getByText(`At 10 days/s the video runs ${length}.`)
    expect(help).not.toHaveClass('warn')
    expect(field(ui, 'Duration').closest('label')).not.toHaveAttribute('data-invalid')
    expect(exportButton(ui)).toBeEnabled()
  })

  it('a typed duration outside the possible range says which durations are possible and blocks the export', async () => {
    // Arrange
    const { ui } = await openSheet()

    // Act
    await commit(field(ui, 'Duration'), '3:00')

    // Assert
    expect(await ui.findByText(/^With these settings the video can last \d+:\d{2}\.\d to 2:00\.0\.$/)).toHaveClass('warn')
    expect(field(ui, 'Duration').closest('label')).toHaveAttribute('data-invalid', 'true')
    expect(exportButton(ui)).toBeDisabled()
  })

  it('ignores a pace or duration that is not a positive number', async () => {
    // Arrange
    const { ui, sheet } = await openSheet()
    const before = facts(sheet)

    // Act
    await commit(field(ui, 'Days a second'), 'fast')
    await commit(field(ui, 'Duration'), 'soon')

    // Assert
    expect(before).toHaveLength(5)
    expect(facts(sheet)).toEqual(before)
    expect(exportButton(ui)).toBeEnabled()
  })

  // Regression: a rejected entry used to stay on screen although it was not in effect.
  it('a rejected entry snaps back to the value in effect', async () => {
    const { ui } = await openSheet()
    const before = (field(ui, 'Duration') as HTMLInputElement).value
    await commit(field(ui, 'Duration'), 'soon')
    expect(field(ui, 'Duration')).toHaveValue(before)
  })

  // QA N4: blend frames change the output frame rate, never the pace or the length.
  it('a blend keeps the pace and the length and raises the frame rate; holds lengthen the video', async () => {
    // Arrange
    const { ui } = await openSheet()
    await commit(field(ui, 'Days a second'), '10')
    const duration = () => (field(ui, 'Duration') as HTMLInputElement).value
    const initial = duration()
    await moreOptions(ui)

    // Act
    await userEvent.click(ui.getByRole('radio', { name: 'Blend 2' }))
    const blended = duration()
    await commit(field(ui, 'Hold the first day, seconds'), '3')
    const held = duration()
    await commit(field(ui, 'Hold the last day, seconds'), '11')

    // Assert
    expect(ui.getByRole('radio', { name: 'Blend 2' })).toHaveAttribute('aria-checked', 'true')
    expect(field(ui, 'Days a second')).toHaveValue('10')
    expect(Math.abs(Number(blended.split(':')[1]) - Number(initial.split(':')[1]))).toBeLessThan(0.2)
    expect(ui.getByText('2 video frames fade each day into the next: the video runs at 30 fps.')).toBeInTheDocument()
    expect(held).not.toBe(blended)
    expect(duration()).toBe(held)
    expect(fact(ui, 'Length')).toHaveTextContent(/^\d+:\d{2}\.\d with holds$/)
  })

  it('a blend the pace would push past 60 fps is offered but disabled, with the reason', async () => {
    const { ui } = await openSheet()
    await moreOptions(ui)
    const blend2 = ui.getByRole('radio', { name: 'Blend 2' })
    expect(blend2).toBeDisabled()
    expect(blend2).toHaveAttribute('title', 'At 30 days/s, Blend 2 would need 90 fps (60 at most).')
    // Critique round 4, item 25: struck through like 4K, not only dimmed.
    expect(ui.getByRole('radiogroup', { name: 'Between days' })).toHaveClass('blend-seg')
    expect(ui.getByRole('radiogroup', { name: 'Size' })).toHaveClass('size-seg')
  })

  it('folds Between days, Hold and Quality under More options, naming their values', async () => {
    const { ui } = await openSheet()
    const toggle = ui.getByRole('button', { name: /^More options/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('More optionsCut · Hold last 1 s · High quality')
    expect(ui.queryByRole('radiogroup', { name: 'Quality' })).toBeNull()
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(ui.getByRole('radiogroup', { name: 'Quality' })).toBeInTheDocument()
  })
})

describe('Export sheet: size, quality and caption', () => {
  it('sizes show their pixel size and block sizes above the aligned frames', async () => {
    // Arrange
    const { ui } = await openSheet()

    // Act
    await userEvent.click(ui.getByRole('radio', { name: '720p' }))

    // Assert
    const chip720 = ui.getByRole('radio', { name: '720p' })
    expect(chip720).toHaveAttribute('aria-checked', 'true')
    expect(ui.getByText(/^\d+ × \d+ px\. 4K is larger than your frames\.$/)).toBeInTheDocument()
    const fourK = ui.getByRole('radio', { name: '4K' })
    expect(fourK).toBeDisabled()
    expect(fourK.getAttribute('title')).toMatch(/^Larger than your frames, which were aligned at .+\. Align again at 4K to export 4K\.$/)
    expect(fact(ui, 'Size')).toHaveTextContent(/^\d+ × \d+$/)
  })

  // P2-13: Size is a segmented control; Source and 1080p gave the same 1080 × 1440.
  it('Size is one segmented choice without twins: Source shows as the 1080p it equals', async () => {
    // Arrange + Act: the session exports at "source" and the frames were aligned at 1080p.
    const { ui, session } = await openSheet()
    expect(session.video.resolution).toBe('source')

    // Assert
    const size = ui.getByRole('radiogroup', { name: 'Size' })
    expect(size).toHaveClass('segmented')
    expect(within(size).getAllByRole('radio').map((r) => r.textContent)).toEqual(['720p', '1080p', '4K'])
    expect(within(size).getByRole('radio', { name: '1080p' })).toHaveAttribute('aria-checked', 'true')
    expect(ui.getByText(/^1080 × 1440 px\. /)).toBeInTheDocument()
  })

  // Critique round 4, item 25: the spec line left the footer for the empty preview column, as facts.
  it('the facts under the preview set only their values in the data font, with the length as in the duration field', async () => {
    // Arrange + Act
    const { ui, sheet } = await openSheet()

    // Assert
    expect(facts(sheet)).toEqual([
      'Video H.264',
      expect.stringMatching(/^Size \d+ × \d+$/),
      'Frame rate 30 fps',
      `Length ${(field(ui, 'Duration') as HTMLInputElement).value} with holds`,
      expect.stringMatching(/^File size ≈ [\d.]+ [kMG]?B$/),
    ])
    expect([...sheet.querySelectorAll('.export-facts .mono')].map((v) => v.textContent)).toEqual([
      expect.stringMatching(/^\d+ × \d+$/),
      '30',
      (field(ui, 'Duration') as HTMLInputElement).value,
      expect.stringMatching(/^[\d.]+$/),
    ])
    expect(sheet.querySelector('.sheet-foot')).not.toHaveTextContent(/H\.264/)
  })

  // Critique round 5, P1-7: "frames" meant two things in the sheet. It counts days; a count of
  // frames is only ever the video's own.
  it('the subtitle counts days, and the caption and holds speak of days', async () => {
    const { ui, sheet, frames } = await openSheet()
    expect(sheet.querySelector('.sheet-head p')).toHaveTextContent(new RegExp(`^${frames.length.toLocaleString('en-US')} days · `))
    expect(ui.getByText('Each day gets its date, burned in')).toBeInTheDocument()
    await moreOptions(ui)
    expect(field(ui, 'Hold the first day, seconds')).toBeInTheDocument()
    expect(field(ui, 'Hold the last day, seconds')).toBeInTheDocument()
  })

  it('quality changes the size estimate', async () => {
    // Arrange
    const { ui } = await openSheet()
    const estimate = () => fact(ui, 'File size').textContent
    await moreOptions(ui)

    // Act
    await userEvent.click(ui.getByRole('radio', { name: 'Small' }))
    const small = estimate()
    await userEvent.click(ui.getByRole('radio', { name: 'Max' }))

    // Assert
    expect(ui.getByRole('radio', { name: 'Max' })).toHaveAttribute('aria-checked', 'true')
    expect(estimate()).toMatch(/^≈ /)
    expect(estimate()).not.toBe(small)
  })

  it('the date caption can be placed, reformatted and resized, and shows on the preview', async () => {
    // Arrange
    const { ui, frames, sheet } = await openSheet()
    const day = frames[0]?.dayKey ?? ''

    // Act: turn it on and place it top right.
    await userEvent.click(ui.getByRole('switch', { name: /Date caption/ }))
    await userEvent.click(ui.getByRole('radio', { name: 'Top right' }))

    // Assert
    expect(ui.getByRole('radio', { name: 'Top right' })).toHaveAttribute('aria-checked', 'true')
    expect(sheet.querySelector('.ep-caption')).toHaveTextContent(strftime('%-d %b %Y', day))

    // Act: pick another date format from its popover.
    await userEvent.click(ui.getByRole('button', { name: strftime('%-d %b %Y', day) }))
    const formats = screen.getByRole('dialog', { name: 'Date format' })
    await userEvent.click(within(formats).getByRole('radio', { name: /%Y-%m-%d/ }))

    // Assert
    expect(screen.queryByRole('dialog', { name: 'Date format' })).toBeNull()
    expect(sheet.querySelector('.ep-caption')).toHaveTextContent(day)

    // Act: pick a larger size.
    await userEvent.click(ui.getByRole('button', { name: 'Size M' }))
    const sizes = screen.getByRole('dialog', { name: 'Caption size' })
    await userEvent.click(within(sizes).getByRole('radio', { name: 'L' }))

    // Assert
    expect(ui.getByRole('button', { name: 'Size L' })).toBeInTheDocument()

    // Act: turn it off again.
    await userEvent.click(ui.getByRole('switch', { name: /Date caption/ }))

    // Assert
    expect(ui.queryByRole('radiogroup', { name: 'Caption position' })).toBeNull()
    expect(sheet.querySelector('.ep-caption')).toBeNull()
  })

  // Regression: Escape in a popover over the sheet used to close the whole sheet.
  it('Escape in a caption popover closes only the popover', async () => {
    const { ui, frames } = await openSheet()
    await userEvent.click(ui.getByRole('switch', { name: /Date caption/ }))
    await userEvent.click(ui.getByRole('button', { name: strftime('%-d %b %Y', frames[0]?.dayKey ?? '') }))
    fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Date format' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Export timelapse' })).toBeInTheDocument()
  })

  it('Even light in the sheet changes the look, and the file size with it', async () => {
    // Arrange
    const { ui } = await openSheet()
    const estimate = () => Number((fact(ui, 'File size').textContent ?? '').replace(/[^\d.]/g, ''))
    const asShot = estimate()

    // Act
    await userEvent.click(ui.getByRole('switch', { name: /Even out light and colour/ }))

    // Assert: evened light compresses better (critique round 5, P1-7: 648 MB as shot, 552 MB evened).
    await waitFor(() => expect(queryClient.getQueryData<FramesView>(queryKeys.frames)?.look.normalize).toBe('exposureAndColor'))
    expect(ui.getByRole('switch', { name: /Even out light and colour/ })).toBeChecked()
    await waitFor(() => expect(estimate()).toBeLessThan(asShot))
  })

  it('a failing look change is reported as a toast', async () => {
    // Arrange
    const { ui } = await openSheet({ fail: { set_look: 'io' } })

    // Act
    await userEvent.click(ui.getByRole('switch', { name: /Even out light and colour/ }))

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.io)).toBeInTheDocument()
  })
})

describe('Export sheet: video export', () => {
  it('⌘↩ exports; Show in Finder reports a failure; Done closes the sheet', async () => {
    // Arrange
    const { ui, sheet, backend } = await openSheet()

    // Act
    fireEvent.keyDown(sheet, { key: 'Enter', ...mod })

    // Assert
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
    expect(savedLead(sheet)).toHaveTextContent(/^Saved · \d+:\d{2}\.\d · [\d.]+ [kMG]?B$/)
    expect(line(ui, /^FaceTimelapse \d{4}–\d{4}\.mp4/)).toHaveTextContent(/^FaceTimelapse \d{4}–\d{4}\.mp4( · took .+)?$/)

    // Act
    backend.configure({ fail: { reveal_path: 'permissionDenied' } })
    await userEvent.click(ui.getByRole('button', { name: /Show in Finder/ }))

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.permissionDenied)).toBeInTheDocument()

    // Act
    await userEvent.click(ui.getByRole('button', { name: 'Done' }))

    // Assert
    expect(screen.queryByRole('dialog', { name: 'Export timelapse' })).toBeNull()
    expect(useView.getState().exportOpen).toBe(false)
    expect(useJobs.getState().exportVideo.summary).toBeNull()
  })

  // QA LOW: ⌘↩ used to do nothing once focus had left the sheet.
  it('⌘↩ exports while the sheet is open even when focus is outside it', async () => {
    const { ui } = await openSheet()
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(window, { key: 'Enter', ...mod })
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
  })

  // UI review 2, M5: ⌘↩ in a number field committed the field and stopped there; the export
  // must use the value just committed, not the settings of the last render.
  it('⌘↩ in a number field commits it, then exports with it', async () => {
    const { ui, backend } = await openSheet()
    const pace = field(ui, 'Days a second')
    pace.focus()
    fireEvent.change(pace, { target: { value: '12' } })
    fireEvent.keyDown(pace, { key: 'Enter', ...mod })
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
    expect(backend.current.video.pace).toEqual({ mode: 'fps', fps: 12 })
  })

  it('⌘↩ does nothing while the settings cannot be exported', async () => {
    // Arrange
    const { ui, sheet } = await openSheet()
    await commit(field(ui, 'Duration'), '0:30')

    // Act
    fireEvent.keyDown(sheet, { key: 'Enter', ...mod })
    fireEvent.keyDown(sheet, { key: 'Enter' })

    // Assert
    expect(useJobs.getState().activeJobId).toBeNull()
    expect(ui.queryByRole('heading', { name: 'Saved' })).toBeNull()
  })

  it('a cancelled save dialog keeps the settings open', async () => {
    // Arrange
    const { ui } = await openSheet({ cancelDialogs: true })

    // Act
    await userEvent.click(exportButton(ui))

    // Assert
    expect(exportButton(ui)).toBeEnabled()
    expect(useJobs.getState().activeJobId).toBeNull()
  })

  it('a save dialog that fails shows a toast', async () => {
    // Arrange
    const { ui } = await openSheet({ fail: { pick_video_path: 'permissionDenied' } })

    // Act
    await userEvent.click(exportButton(ui))

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.permissionDenied)).toBeInTheDocument()
  })

  it('a failed encode shows a stop notice in the settings', async () => {
    // Arrange
    const { ui } = await openSheet({ fail: { exportVideoMidway: 'encodeFailed' } })

    // Act
    await userEvent.click(exportButton(ui))

    // Assert
    const notice = await ui.findByRole('alert')
    expect(notice).toHaveTextContent('The export stopped.')
    expect(notice).toHaveTextContent(`${DEFAULT_MESSAGES.encodeFailed} Nothing half-written was left behind.`)
  })

  it('shows progress while encoding, cannot be dismissed, and Stop leaves a notice', async () => {
    // Arrange
    const { ui, backend } = await openSheet()
    backend.configure({ speed: 'fast' })

    // Act
    await userEvent.click(exportButton(ui))

    // Assert: a visual counter, and one throttled live region instead of a chatty one (M11).
    const counter = await ui.findByText(/^Encoding/, { selector: '.enc-num' })
    expect(counter.closest('[aria-live]')).toBeNull()
    // The first announcement comes before the total is known; then it counts.
    expect(ui.getByRole('status')).toHaveTextContent(/^(Encoding started\.|Encoding day [\d,]+ of [\d,]+\.)$/)
    expect(ui.getByRole('progressbar', { name: 'Export progress' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Export timelapse' })).toBeInTheDocument()

    // Act
    await userEvent.click(ui.getByRole('button', { name: /Stop/ }))

    // Assert
    expect(await ui.findByText('Export stopped. Nothing half-written was left behind.', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(exportButton(ui)).toBeEnabled()
  })
})

describe('Export sheet: frames as images', () => {
  it('writes JPEG frames into a folder and a second export renames clashes', async () => {
    // Arrange
    const { ui, frames, sheet } = await openSheet()
    await userEvent.click(ui.getByRole('radio', { name: 'Frames' }))
    await userEvent.click(ui.getByRole('radio', { name: 'JPEG' }))
    const quality = field(ui, 'JPEG quality, 50 to 100')

    // Act
    await commit(quality, '20')
    const rejected = useJobs.getState().exportImages
    await commit(quality, '80')

    // Assert
    expect(rejected.summary).toBeNull()
    expect(field(ui, 'JPEG quality, 50 to 100')).toHaveValue('80')
    expect(fact(ui, 'Files')).toHaveTextContent(`${frames.length.toLocaleString('en-US')} JPEG`)
    expect(fact(ui, 'Size')).toHaveTextContent(/^\d+ × \d+$/)

    // Act
    await userEvent.click(exportButton(ui))

    // Assert
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
    expect(savedLead(sheet)).toHaveTextContent(`Saved · ${frames.length.toLocaleString('en-US')} files`)
    expect(line(ui, /^~\/Pictures\/Timelapse frames/)).toBeInTheDocument()

    // Act: export the same frames again into the same folder.
    await userEvent.click(ui.getByRole('button', { name: 'Done' }))
    fireEvent.keyDown(window, { key: 'e' })
    const again = within(await screen.findByRole('dialog', { name: 'Export timelapse' }))
    await userEvent.click(again.getByRole('radio', { name: 'Frames' }))
    await userEvent.click(again.getByRole('button', { name: /^Export…/ }))

    // Assert
    expect(await again.findByText(/got a _1 suffix( · took .+)?$/)).toBeInTheDocument()
  })

  it('the overwrite switch replaces same-named files instead of renaming', async () => {
    // Arrange
    const { ui } = await openSheet()
    await userEvent.click(ui.getByRole('radio', { name: 'Frames' }))

    // Act
    await userEvent.click(ui.getByRole('switch', { name: /Replace files with the same name/ }))

    // Assert
    expect(ui.getByRole('switch', { name: /Replace files with the same name/ })).toBeChecked()
    expect(ui.getByRole('switch', { name: /Even out light and colour/ })).not.toBeChecked()
  })

  it('a failed image export shows the stop notice', async () => {
    // Arrange
    const { ui } = await openSheet({ fail: { exportImagesMidway: 'diskFull' } })
    await userEvent.click(ui.getByRole('radio', { name: 'Frames' }))

    // Act
    await userEvent.click(exportButton(ui))

    // Assert
    expect(await ui.findByRole('alert')).toHaveTextContent(DEFAULT_MESSAGES.diskFull)
  })
})

describe('Export sheet: closing', () => {
  it('Cancel, Escape and the scrim close the sheet', async () => {
    // Arrange
    const { ui } = await openSheet()

    // Act + Assert
    await userEvent.click(ui.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Export timelapse' })).toBeNull()

    fireEvent.keyDown(window, { key: 'e' })
    await screen.findByRole('dialog', { name: 'Export timelapse' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Export timelapse' })).toBeNull()

    fireEvent.keyDown(window, { key: 'e' })
    await screen.findByRole('dialog', { name: 'Export timelapse' })
    fireEvent.click(document.querySelector('.sheet-scrim') as HTMLElement)
    expect(screen.queryByRole('dialog', { name: 'Export timelapse' })).toBeNull()
  })
})

describe('Export sheet: opening over playback (M13)', () => {
  it('pauses playback and previews the frame on screen', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    const frames = queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames ?? []
    act(() => usePlayer.setState({ index: 12, settled: 9, playing: true }))

    // Act
    fireEvent.keyDown(window, { key: 'e' })
    const sheet = within(await screen.findByRole('dialog', { name: 'Export timelapse' }))

    // Assert
    expect(usePlayer.getState()).toMatchObject({ playing: false, settled: 12 })
    await waitFor(() => expect(sheet.getByRole('img', { name: 'Preview of the current frame' }).getAttribute('src')).toContain(frames[12]?.photoId))
  })
})

describe('Export sheet: settings shown as they are (L3, L4)', () => {
  function seedVideo(patch: Partial<SessionSnapshot['video']>) {
    act(() => {
      queryClient.setQueryData<SessionSnapshot>(queryKeys.session, (s) => (s ? { ...s, video: { ...s.video, ...patch } } : s))
    })
  }

  it('a blend length outside the presets is its own checked, tabbable choice', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    seedVideo({ pace: { mode: 'fps', fps: 20 }, crossfade: { frames: 3, easing: 'easeInOut' } })

    // Act
    fireEvent.keyDown(window, { key: 'e' })
    const ui = within(await screen.findByRole('dialog', { name: 'Export timelapse' }))
    await moreOptions(ui)

    // Assert
    const blend3 = ui.getByRole('radio', { name: 'Blend 3' })
    expect(blend3).toHaveAttribute('aria-checked', 'true')
    expect(blend3).toHaveAttribute('tabindex', '0')
    await userEvent.click(ui.getByRole('radio', { name: 'Blend 4' }))
    expect(ui.getByRole('radio', { name: 'Blend 4' })).toHaveAttribute('aria-checked', 'true')
  })

  it('a custom bitrate shows as its own choice instead of “High”', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    seedVideo({ quality: { bitrate: { kbps: 8000 } } })

    // Act
    fireEvent.keyDown(window, { key: 'e' })
    const ui = within(await screen.findByRole('dialog', { name: 'Export timelapse' }))
    await moreOptions(ui)
    const custom = ui.getByRole('radio', { name: '8,000 kbps' })

    // Assert
    expect(custom).toHaveAttribute('aria-checked', 'true')
    expect(ui.getByRole('radio', { name: 'High' })).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(custom)
    expect(custom).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(ui.getByRole('radio', { name: 'Max' }))
    expect(ui.queryByRole('radio', { name: '8,000 kbps' })).toBeNull()
  })

  // Regression (L4): the sheet's switch always turned the look back on as exposure and colour.
  it('the Even light switch turns the look back on in the mode last used', async () => {
    // Arrange: the player used Exposure, then turned Even light off.
    await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    const look = () => queryClient.getQueryData<FramesView>(queryKeys.frames)?.look.normalize
    fireEvent.keyDown(window, { key: 'n' })
    await waitFor(() => expect(look()).toBe('exposureAndColor'))
    await userEvent.click(screen.getByRole('button', { name: 'Even light settings' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Exposure' }))
    await waitFor(() => expect(look()).toBe('exposure'))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'n' })
    await waitFor(() => expect(look()).toBe('off'))

    // Act
    fireEvent.keyDown(window, { key: 'e' })
    const ui = within(await screen.findByRole('dialog', { name: 'Export timelapse' }))
    await userEvent.click(ui.getByRole('switch', { name: /Even out light and colour/ }))

    // Assert
    await waitFor(() => expect(look()).toBe('exposure'))
  })
})

describe('Export sheet: announcements (M11)', () => {
  it('says when the video is saved', async () => {
    // Arrange
    const { ui, sheet } = await openSheet()

    // Act
    fireEvent.keyDown(sheet, { key: 'Enter', ...mod })

    // Assert
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
    expect(ui.getByRole('status')).toHaveTextContent(/^Saved FaceTimelapse \d{4}–\d{4}\.mp4\.$/)
  })

  it('says how many frames were saved', async () => {
    // Arrange
    const { ui, frames } = await openSheet()
    await userEvent.click(ui.getByRole('radio', { name: 'Frames' }))

    // Act
    await userEvent.click(exportButton(ui))

    // Assert
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
    expect(ui.getByRole('status')).toHaveTextContent(`Saved ${frames.length.toLocaleString('en-US')} files.`)
  })
})

// QA 24: the frames export said ".png" for JPEG and showed the video's size on the preview.
describe('Export sheet: frames copy and preview size (QA 24)', () => {
  it('the clash help names the chosen format’s files; the preview shows the size that is written', async () => {
    // Arrange
    const { ui } = await openSheet()
    const master = queryClient.getQueryData<FramesView>(queryKeys.frames)?.outputSize ?? { width: 0, height: 0 }
    const small = outputSize('720p', master.width, master.height)
    await userEvent.click(ui.getByRole('radio', { name: '720p' }))
    const size = () => fact(ui, 'Size')
    expect(size()).toHaveTextContent(`${small?.width} × ${small?.height}`)

    // Act
    await userEvent.click(ui.getByRole('radio', { name: 'Frames' }))

    // Assert: frames are written at the aligned size, whatever the video size.
    expect(size()).toHaveTextContent(`${master.width} × ${master.height}`)
    expect(ui.getByText('Off: a clash becomes 20140814_1.png, never overwritten')).toBeInTheDocument()

    // Act
    await userEvent.click(ui.getByRole('radio', { name: 'JPEG' }))

    // Assert
    expect(ui.getByText('Off: a clash becomes 20140814_1.jpg, never overwritten')).toBeInTheDocument()
    expect(ui.queryByText(/\.png/)).toBeNull()
  })
})

// QA 29: the saved folder is shown short ("~", middle truncation) with the full path in a tooltip;
// Show in Finder still gets the real path.
describe('Export sheet: saved paths (QA 29)', () => {
  it('shows the frames folder short, with the full path in its title, and reveals the real path', async () => {
    // Arrange
    const { ui, backend } = await openSheet()
    const reveal = vi.spyOn(backend, 'handle')
    await userEvent.click(ui.getByRole('radio', { name: 'Frames' }))

    // Act
    await userEvent.click(exportButton(ui))

    // Assert
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
    const folder = ui.getByText('~/Pictures/Timelapse frames')
    expect(folder).toHaveAttribute('title', EXPORT_FOLDER)
    expect(ui.queryByText(new RegExp(EXPORT_FOLDER))).toBeNull()

    // Act
    await userEvent.click(ui.getByRole('button', { name: /Show in Finder/ }))

    // Assert
    await waitFor(() => expect(reveal.mock.calls.filter(([cmd]) => cmd === 'reveal_path').map(([, args]) => args)).toEqual([{ path: EXPORT_FOLDER }]))
  })

  it('the saved video’s name carries its full path in its title', async () => {
    // Arrange
    const { ui, sheet } = await openSheet()

    // Act
    fireEvent.keyDown(sheet, { key: 'Enter', ...mod })

    // Assert
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
    const path = useJobs.getState().exportVideo.summary?.path ?? ''
    expect(path).toMatch(/^\/Users\/demo\/Movies\/FaceTimelapse \d{4}–\d{4}\.mp4$/)
    expect(ui.getByText(/^FaceTimelapse \d{4}–\d{4}\.mp4$/)).toHaveAttribute('title', path)
  })
})

// QA 5: counts read correctly at 1.
describe('Export sheet: counts at one (QA 5)', () => {
  it('says "1 file" when one frame was written', async () => {
    // Arrange
    const { ui, sheet } = await openSheet()
    await userEvent.click(ui.getByRole('radio', { name: 'Frames' }))

    // Act
    act(() => {
      useJobs.setState((s) => ({ exportImages: { ...s.exportImages, summary: { jobId: 'export-1', dir: EXPORT_FOLDER, written: 1, renamed: 1, durationMs: 5 } } }))
    })

    // Assert: a 5 ms export doesn't say how long it took.
    expect(await ui.findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
    expect(savedLead(sheet)).toHaveTextContent('Saved · 1 file')
    expect(line(ui, /^~\/Pictures/)).toHaveTextContent('~/Pictures/Timelapse frames · 1 got a _1 suffix')
    expect(ui.getByRole('status')).toHaveTextContent('Saved 1 file.')
  })
})

// QA 1: the preview is an ftimg thumbnail like the others and recovers from a failed load.
describe('Export sheet: preview that fails to load', () => {
  it('asks for the preview again', async () => {
    // Arrange
    const { ui } = await openSheet()
    const preview = ui.getByRole('img', { name: 'Preview of the current frame' })
    const src = preview.getAttribute('src') ?? ''

    // Act
    fireEvent.error(preview)

    // Assert
    await waitFor(() => expect(preview.getAttribute('src')).toBe(withRetryParam(src, 1)), { timeout: 2000 })
  })
})
