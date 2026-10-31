import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SessionSnapshot } from '../../ipc/contract'
import { DEFAULT_MESSAGES } from '../../ipc/mock/errors'
import { MODELS_MISSING } from '../../state/models'
import { updateFolder } from '../../ipc/mock/state'
import { renderApp } from '../../test/renderApp'
import { stubLayout } from '../../test/layout'
import { cancelActiveJob, startScan, useJobs } from '../../state/jobs'
import { queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'
import { formatCount } from '../../lib/format'
import { LiveRate } from './ScanScreen'

const mod = { metaKey: true, ctrlKey: true }
const title = () => screen.getByRole('heading', { level: 1 })
const session = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session) as SessionSnapshot

describe('Scan: while reading', () => {
  it('shows live progress; Stop asks first, then keeps what was read and Resume continues', async () => {
    // Arrange
    stubLayout()
    const { backend } = await renderApp({ scenario: 'ready' })
    backend.configure({ speed: 'fast' })

    // Act
    await act(async () => {
      await startScan()
    })

    // Assert
    expect(title()).toHaveTextContent('Scan')
    expect(await screen.findByRole('heading', { name: /^Read [\d,]+ of 3,593 photos$/ })).toBeInTheDocument()
    expect(within(screen.getByRole('main')).getByRole('progressbar', { name: 'Scan progress' })).toBeInTheDocument()
    expect(screen.getByLabelText('Matched photos, newest last')).toBeInTheDocument()
    await waitFor(() => expect(useJobs.getState().scan.progress).not.toBeNull())

    // Act: open the stop confirmation and keep scanning.
    await userEvent.click(screen.getByRole('button', { name: /Stop/ }))
    const confirm = within(screen.getByRole('dialog', { name: 'Stop scanning?' }))
    expect(confirm.getByText(/photos read so far are remembered/)).toBeInTheDocument()
    await userEvent.click(confirm.getByRole('button', { name: 'Keep scanning' }))
    expect(screen.queryByRole('dialog', { name: 'Stop scanning?' })).toBeNull()

    // Act: stop for real.
    await userEvent.click(screen.getByRole('button', { name: /Stop/, expanded: false }))
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Stop scanning?' })).getByRole('button', { name: 'Stop' }))

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Reference'), { timeout: 3000 })
    expect(session().scan.status).toBe('partial')

    // Act: the library view offers to resume.
    fireEvent.keyDown(window, { key: '2', ...mod })
    expect(await screen.findByRole('heading', { name: /^Stopped after [\d,]+ photos$/ })).toBeInTheDocument()
    backend.configure({ speed: 'instant' })
    await userEvent.click(screen.getByRole('button', { name: /Resume scan/ }))

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Review'), { timeout: 3000 })
    expect(session().scan.status).toBe('complete')
  })

  it('⌘↩ resumes a stopped scan, and a resume that cannot start is reported', async () => {
    // Arrange
    const { backend } = await renderApp({ scenario: 'ready', fail: { scanMidway: 'io' } })
    await act(async () => {
      await startScan()
    })
    await waitFor(() => expect(session().scan.status).toBe('partial'))
    await waitFor(() => expect(title()).toHaveTextContent('Reference'))
    fireEvent.keyDown(window, { key: '2', ...mod })
    await screen.findByRole('button', { name: /Resume scan/ })
    backend.configure({ fail: { start_scan: 'modelUnavailable' } })

    // Act
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert
    expect(await screen.findByText(MODELS_MISSING)).toBeInTheDocument()
  })
})

describe('Scan: the library afterwards', () => {
  it('with unsure photos it offers Review or Skip review', async () => {
    // Arrange
    await renderApp({ scenario: 'scanned' })
    fireEvent.keyDown(window, { key: '2', ...mod })
    const review = await screen.findByRole('button', { name: /^Review 41 unsure/ })
    expect(screen.getByText('41 need your eye')).toBeInTheDocument()

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Skip review' }))

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Days'))
    fireEvent.keyDown(window, { key: '2', ...mod })
    await userEvent.click(await screen.findByRole('button', { name: /^Review 41 unsure/ }))
    await waitFor(() => expect(title()).toHaveTextContent('Review'))
    expect(review).not.toBeInTheDocument()
  })

  it('with nothing unsure it continues to Days, also with ⌘↩', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '2', ...mod })
    expect(await screen.findByText('Nothing needs your eye')).toBeInTheDocument()

    // Act
    await userEvent.click(screen.getByRole('button', { name: /Continue to Days/ }))

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Days'))
    fireEvent.keyDown(window, { key: '2', ...mod })
    await screen.findByRole('button', { name: /Continue to Days/ })
    fireEvent.keyDown(window, { key: 'Enter', ...mod })
    await waitFor(() => expect(title()).toHaveTextContent('Days'))
  })

  it('filters the library and leaves a selected photo out', async () => {
    // Arrange
    stubLayout()
    await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '2', ...mod })
    await screen.findByText('Select a photo to keep it or leave it out.')

    // Act
    await userEvent.click(screen.getByRole('radio', { name: 'You' }))
    const sheet = await screen.findByLabelText('Photos in the library')
    const [first] = await within(sheet).findAllByRole('button')
    await userEvent.click(first as HTMLElement)
    const before = session().counts.included
    await userEvent.click(screen.getByRole('button', { name: /Leave out/ }))

    // Assert
    expect(useView.getState().scanFilter).toBe('confirmed')
    await waitFor(() => expect(session().counts.included).toBe(before - 1))
    expect(await screen.findByText('Select a photo to keep it or leave it out.')).toBeInTheDocument()
  })

  it('photos without a face cannot be kept, and a failing decision is reported', async () => {
    // Arrange
    stubLayout()
    const { backend } = await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '2', ...mod })
    await userEvent.click(await screen.findByRole('radio', { name: 'No face' }))
    const sheet = await screen.findByLabelText('Photos in the library')
    await userEvent.click((await within(sheet).findAllByRole('button'))[0] as HTMLElement)

    // Assert
    expect(screen.getByRole('button', { name: /Use this photo/ })).toBeDisabled()

    // Act
    await userEvent.click(screen.getByRole('radio', { name: 'Not you' }))
    await userEvent.click((await within(sheet).findAllByRole('button'))[0] as HTMLElement)
    backend.configure({ fail: { set_review_decision: 'io' } })
    await userEvent.click(screen.getByRole('button', { name: /Use this photo/ }))

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.io)).toBeInTheDocument()
  })
})

// Critique round 4, P2-16: "◐ 41 unsure" stood beside "Nothing needs your eye", and "⊘ 0 remembered" showed.
describe('the library tally says what is true now', () => {
  const tallyLine = () => Array.from(document.querySelectorAll<HTMLElement>('.scan-band .tally > span')).map((s) => s.textContent?.replace(/\s+/g, ' ').trim())

  it('after review: you (with the kept), kept, left out and someone else; no unsure, no zeros, no side note', async () => {
    // Arrange + Act
    await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '2', ...mod })
    await screen.findByText('Nothing needs your eye')

    // Assert
    const c = session().counts
    await waitFor(() => expect(tallyLine()).toContain('29 kept'))
    expect(tallyLine()).toEqual([`${formatCount(c.included)} you`, '29 kept', '12 left out', `${formatCount(c.rejected + c.noFace)} someone else or no face`])
    expect(screen.queryByText('Unsure photos stay out unless you keep them.')).toBeNull()
  })

  it('while photos wait: unsure beside "need your eye", with the side note', async () => {
    // Arrange + Act
    await renderApp({ scenario: 'scanned' })
    fireEvent.keyDown(window, { key: '2', ...mod })
    await screen.findByText('41 need your eye')

    // Assert
    expect(tallyLine()).toContain('41 unsure')
    expect(tallyLine().some((t) => t?.includes('kept') || t?.includes('left out') || t?.includes('remembered'))).toBe(false)
    expect(screen.getByText('Unsure photos stay out unless you keep them.')).toBeInTheDocument()
  })
})

describe('M11: the live scan speaks sparingly', () => {
  it('has one polite announcer and no live region on the fast-changing counters', async () => {
    const { container } = await renderApp({ scenario: 'ready', speed: 'normal' })
    await act(async () => {
      await startScan()
    })
    await screen.findByRole('heading', { name: /^Read / })
    expect(container.querySelector('.scan-line')).not.toHaveAttribute('aria-live')
    const regions = Array.from(container.querySelectorAll('[aria-live="polite"]')).filter((el) => el.closest('.scan-screen'))
    expect(regions).toHaveLength(1)
    fireEvent.keyDown(window, { key: '.', metaKey: true, ctrlKey: true })
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull(), { timeout: 8000 })
  })
})

describe('critique P2-7: the scan ribbon is part of the screen chrome', () => {
  it('the live scan and the library put their ribbon in the ribbon row, not inside the clipped canvas', async () => {
    await renderApp({ scenario: 'ready', speed: 'normal' })
    await act(async () => {
      await startScan()
    })
    const live = await screen.findByRole('contentinfo', { name: 'Days found so far' })
    expect(live.closest('.screen')).toBeNull()
    fireEvent.keyDown(window, { key: '.', metaKey: true, ctrlKey: true })
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull(), { timeout: 8000 })
  })

  // Critique round 5, P1-6: the outline sat on frames still black (2169, 54, 3070, 1717).
  // Integration (batch 13): live frames were named by their raw day key ("2016-04-03").
  it('names each live frame by its date in words', async () => {
    stubLayout(1200, 800)
    const { container } = await renderApp({ scenario: 'ready', speed: 'normal' })
    await act(async () => {
      await startScan()
    })
    await waitFor(() => expect(container.querySelector('.sheet-scroll .frame-cell')).not.toBeNull(), { timeout: 4000 })
    const name = container.querySelector('.sheet-scroll .frame-cell')?.getAttribute('aria-label') ?? ''
    expect(name).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}(, unsure)?$/)
    // The scan stops with the test, so the next one starts from a quiet backend.
    await act(async () => {
      await cancelActiveJob()
    })
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull(), { timeout: 4000 })
  })

  it('outlines the newest developed photo, never one whose image hasn’t landed', async () => {
    // Arrange
    stubLayout(1200, 800)
    const { container } = await renderApp({ scenario: 'ready', speed: 'normal' })
    await act(async () => {
      await startScan()
    })
    await waitFor(() => expect(container.querySelectorAll('.sheet-scroll .frame-cell img').length).toBeGreaterThan(1), { timeout: 4000 })
    expect(container.querySelector('.frame-cell.reading')).toBeNull()
    const imgs = Array.from(container.querySelectorAll<HTMLImageElement>('.sheet-scroll .frame-cell img'))
    const last = imgs[imgs.length - 1] as HTMLImageElement

    // Act: only the newest image lands.
    act(() => {
      fireEvent.load(last)
    })

    // Assert: it waits for the frames before it; nothing is outlined.
    expect(container.querySelector('.frame-cell.newest')).toBeNull()

    // Act: the rest land, and every develop ends.
    act(() => {
      for (const img of imgs) fireEvent.load(img)
    })
    for (const img of imgs) {
      act(() => {
        img.dispatchEvent(new Event('AnimationEvent' in window ? 'animationend' : 'webkitAnimationEnd', { bubbles: true }))
      })
    }

    // Assert
    const newest = container.querySelector('.frame-cell.newest')
    expect(newest).toBe(last.closest('.frame-cell'))
    expect(newest).toHaveAttribute('data-film', 'fixed')
    fireEvent.keyDown(window, { key: '.', metaKey: true, ctrlKey: true })
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull(), { timeout: 8000 })
  })
})

describe('HIGH-3: the library never mounts the whole folder', () => {
  it('keeps the mounted thumbnails to the rows in view (3,593 photos → about a hundred thumbnails)', async () => {
    stubLayout(1200, 800)
    const { container } = await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '2', metaKey: true, ctrlKey: true })
    await screen.findByLabelText('Photos in the library')
    await waitFor(() => expect(container.querySelectorAll('.sheet-scroll img').length).toBeGreaterThan(0))
    expect(container.querySelectorAll('.sheet-scroll img').length).toBeLessThan(150)
  })
})

// N5: with the face models missing and no scan results, Scan read "Found you
// in 0 of 0 photos · Read in 40 s", a finished scan the app couldn't have run.
describe('Scan with no results to show', () => {
  async function scanWithNoResults(modelsMissing: boolean, library: 'demo' | 'empty' = 'demo') {
    const r = await renderApp({ scenario: 'scanned', modelsMissing })
    r.backend.replaceState((s) => updateFolder(s, (f) => ({ ...f, library, libraryCount: 0 })))
    await act(() => queryClient.invalidateQueries())
    await waitFor(() => expect(session().counts.total).toBe(0))
    expect(session().scan.status).toBe('complete')
    fireEvent.keyDown(window, { key: '2', ...mod })
    await screen.findByRole('heading', { name: 'No scan results to show' })
    return r
  }

  // Critique round 4, P2-20: ScanEmpty was a sentence on a blank canvas.
  it('keeps the band’s shape: statement, folder facts, and two strips of unexposed film', async () => {
    // Arrange + Act
    const { container } = await scanWithNoResults(false)

    // Assert
    const facts = within(container.querySelector('.scan-empty-facts') as HTMLElement)
    expect(facts.getByText('Folder')).toBeInTheDocument()
    expect(facts.getByText(session().folder?.name ?? '')).toBeInTheDocument()
    expect(facts.getByText('Photos')).toBeInTheDocument()
    const film = container.querySelector('.scan-empty-film') as HTMLElement
    expect(film).toHaveAttribute('aria-hidden', 'true')
    const strips = film.querySelectorAll('.strip')
    expect(strips).toHaveLength(2)
    expect(strips[0]?.querySelectorAll('.frame-cell.unexposed').length).toBeGreaterThanOrEqual(7)
  })

  it('says why when the face models are missing, with no finished-scan claim and Scan library blocked', async () => {
    // Arrange + Act
    await scanWithNoResults(true)

    // Assert
    expect(screen.getByText(/The face models are missing, so this library can’t be read/)).toBeInTheDocument()
    expect(screen.queryByText(/Found you in/)).toBeNull()
    expect(screen.queryByText(/^Read in/)).toBeNull()
    expect(screen.queryByRole('contentinfo', { name: 'Days with a photo' })).toBeNull()
    const plate = screen.getByRole('button', { name: /^Scan library/ })
    expect(plate).toBeDisabled()
    expect(plate).toHaveAttribute('title', MODELS_MISSING)
    fireEvent.keyDown(window, { key: 'Enter', ...mod })
    expect(useJobs.getState().activeKind).toBeNull()
  })

  // UI review 4, L4: a folder with no photos was offered a rescan that could only find nothing.
  it('for a folder with no photos, says so and offers another folder instead of a rescan', async () => {
    // Arrange
    const { backend } = await scanWithNoResults(false, 'empty')
    expect(session().folder?.imageCount).toBe(0)
    expect(screen.getByText('This folder has no photos FaceTimelapse can read. Choose the folder with your daily photos.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Scan library/ })).toBeNull()

    // Act: ⌘↩ opens the folder dialog (the mock answers with a folder at once).
    const pick = vi.spyOn(backend, 'handle')
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert: the choice was asked for, and the app went back to Reference with it.
    await waitFor(() => expect(title()).toHaveTextContent('Reference'))
    expect(pick.mock.calls.map(([cmd]) => cmd)).toContain('pick_source_folder')
    expect(pick.mock.calls.map(([cmd]) => cmd)).not.toContain('start_scan')
  })

  it('offers Scan library (also ⌘↩) when the models are there', async () => {
    // Arrange
    await scanWithNoResults(false)
    expect(screen.getByText('Scan the library to find your face in it.')).toBeInTheDocument()

    // Act
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert
    await waitFor(() => expect(session().counts.total).toBeGreaterThan(0))
  })
})

// Critique round 2: the library's ribbon stayed on 2022 while the rows on screen were from 2012.
describe('the library ribbon follows the sheet', () => {
  it('marks the days on screen, and a seek on the ribbon scrolls the sheet there', async () => {
    // Arrange: jsdom has no element scrolling; record where the sheet is asked to scroll.
    stubLayout(1200, 800)
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100_000)
    await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '2', ...mod })
    await screen.findByLabelText('Photos in the library')
    const ribbon = within(screen.getByRole('contentinfo', { name: 'Days with a photo' }))
    const slider = ribbon.getByRole('slider', { name: 'Days with a photo' })

    // Assert: the library lists by file path, so the 2016/ folder comes first; the ribbon shows that year.
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuetext', '1 January 2016'))
    expect(ribbon.getByText('2016', { selector: '.ribbon-label' })).toBeInTheDocument()

    // Act: seek to 2019 on the ribbon (the decade starts on 1 Jan 2012).
    fireEvent.change(slider, { target: { value: String(365 * 7 + 2) } })

    // Assert
    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
    const target = scrollTo.mock.calls.at(-1)?.[0] as { top: number }
    expect(target.top).toBeGreaterThan(0)
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  })
})

// The library's ribbon shows the day's photo in its loupe, captioned in words (critique round 4).
describe('the library ribbon loupe', () => {
  it('shows the photo of a hovered day', async () => {
    // Arrange
    stubLayout(365, 34)
    const { container } = await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '2', ...mod })
    await waitFor(() => expect(container.querySelector('.frame-cell')).not.toBeNull())
    const track = container.querySelector('.ribbon-track') as HTMLElement

    // Act: across the focus year, until a day with a photo is under the pointer.
    let img: Element | null = null
    for (let x = 0.5; x < 365 && !img; x += 7) {
      fireEvent.pointerMove(track, { pointerId: 1, clientX: x })
      img = container.querySelector('.ribbon-loupe img')
    }

    // Assert
    expect(img?.getAttribute('src')).toMatch(/thumb\/.+\?w=\d+&v=/)
    expect(container.querySelector('.ribbon-loupe')).toHaveTextContent(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}$/)
  })
})

// Critique round 5, P3-23: "Starting…" was set in the data font.
describe('the live rate line', () => {
  it('says "Starting…" in the UI face; only the data is mono', () => {
    // Act
    const { container } = render(<LiveRate progress={null} workers={12} />)

    // Assert
    const starting = screen.getByText('Starting…')
    expect(starting).toHaveClass('meta')
    expect(starting).not.toHaveClass('mono-meta')
    expect(container.querySelectorAll('.digits').length).toBeGreaterThan(0)
  })

  it('names the current file in the data font once photos are being read', () => {
    render(<LiveRate progress={{ photosPerSecond: 38.4, etaMs: 36_000, currentFile: 'IMG_20180310.jpg' }} workers={12} />)
    expect(screen.getByText('IMG_20180310.jpg')).toHaveClass('mono-meta')
    expect(screen.queryByText('Starting…')).toBeNull()
  })
})

// Critique round 5, P3-26: the stopped-scan notice lived only in the Reference inspector, hidden with ⌥⌘I.
describe('a stopped scan says so on the Scan band', () => {
  it('stopped by you: "Stopped at N of M. The next scan continues from here." in safelight', async () => {
    // Arrange
    await renderApp({ scenario: 'ready', speed: 'normal' })
    await act(async () => {
      await startScan()
    })
    await waitFor(() => expect(useJobs.getState().scan.progress?.done ?? 0).toBeGreaterThan(0), { timeout: 4000 })

    // Act
    await act(async () => {
      await cancelActiveJob()
    })
    await waitFor(() => expect(session().scan.status).toBe('partial'), { timeout: 4000 })
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull(), { timeout: 4000 })
    fireEvent.keyDown(window, { key: '2', ...mod })
    await screen.findByRole('heading', { name: /^Stopped after [\d,]+ photos$/ })

    // Assert
    const folder = session().folder
    const where = await screen.findByText(`Stopped at ${formatCount(folder?.analyzedCount ?? 0)} of ${formatCount(folder?.imageCount ?? 0)}.`)
    const notice = where.closest('.notice') as HTMLElement
    expect(notice).toHaveClass('notice-safelight')
    expect(notice).toHaveTextContent('The next scan continues from here.')
    expect(notice.closest('.scan-band')).not.toBeNull()
  })

  it('stopped by a failure: the reason in stop red, and where it stopped', async () => {
    // Arrange
    await renderApp({ scenario: 'ready', fail: { scanMidway: 'io' } })
    await act(async () => {
      await startScan()
    })
    await waitFor(() => expect(session().scan.status).toBe('partial'))
    await waitFor(() => expect(title()).toHaveTextContent('Reference'))

    // Act
    fireEvent.keyDown(window, { key: '2', ...mod })

    // Assert
    const lead = await screen.findByText('The scan stopped.')
    const notice = lead.closest('.notice') as HTMLElement
    expect(notice).toHaveClass('notice-stop')
    expect(notice.closest('.scan-band')).not.toBeNull()
    expect(notice).toHaveTextContent(/Stopped at [\d,]+ of [\d,]+\. The next scan continues from here\./)
  })

  it('a complete scan shows no notice', async () => {
    await renderApp({ scenario: 'scanned' })
    fireEvent.keyDown(window, { key: '2', ...mod })
    await screen.findByText('41 need your eye')
    expect(document.querySelector('.scan-band .notice')).toBeNull()
  })
})
