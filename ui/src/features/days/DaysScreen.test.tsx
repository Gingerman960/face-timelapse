import { Profiler } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DayGroup, SessionSnapshot } from '../../ipc/contract'
import { call } from '../../ipc/client'
import { installMockBackend, type MockOptions } from '../../ipc/mock/install'
import { DEFAULT_MESSAGES } from '../../ipc/mock/errors'
import { MODELS_MISSING } from '../../state/models'
import { renderApp, resetStores } from '../../test/renderApp'
import { stubLayout } from '../../test/layout'
import { queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'
import { useJobs } from '../../state/jobs'
import { usePlayer } from '../../state/player'
import DaysScreen from './DaysScreen'

const mod = { metaKey: true, ctrlKey: true }
const title = () => screen.getByRole('heading', { level: 1 })
const view = () => useView.getState()
const days = () => queryClient.getQueryData<DayGroup[]>(queryKeys.days) ?? []
const dayOf = (key: string) => days().find((d) => d.dayKey === key)
const session = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session) as SessionSnapshot
const inspector = () => within(screen.getByRole('complementary', { name: 'Selected day' }))

async function openDays(opts: Partial<MockOptions> = {}, day = '2014-05-02') {
  const app = await renderApp({ scenario: 'aligned', ...opts })
  fireEvent.keyDown(window, { key: '4', ...mod })
  await screen.findByRole('complementary', { name: 'Selected day' })
  await act(async () => {
    view().setActiveDay(day)
    view().setDaysYear(Number(day.slice(0, 4)))
  })
  return app
}

/** Opens Days on a day with several photos, so alternates can be chosen. */
async function openDayWithAlternates(opts: Partial<MockOptions> = {}): Promise<DayGroup> {
  await openDays(opts)
  const target = days().find((d) => d.photoIds.length > 2 && !d.excluded) as DayGroup
  await act(async () => view().setActiveDay(target.dayKey))
  return target
}

/** A 2D context stub so canvas drawing code runs under jsdom. */
function fakeContext() {
  const ctx = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1 }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  return ctx
}

/** jsdom has no layout: puts the drag handle and its overlay top-left and only `day` under the drop point. */
function stubDragGeometry(day: string) {
  const far = { x: -9999, y: -9999, left: -9999, top: -9999, width: 1, height: 1, right: -9998, bottom: -9998, toJSON: () => ({}) }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = (x: number, y: number) => ({ x, y, left: x, top: y, width: 40, height: 40, right: x + 40, bottom: y + 40, toJSON: () => ({}) })
    if (this.getAttribute('data-day') === day) return box(500, 500) as DOMRect
    if (this.classList.contains('alt') || this.classList.contains('drag-ghost')) return box(0, 0) as DOMRect
    return far as DOMRect
  })
}

/** Presses the day's first photo and drags it over `day` (see stubDragGeometry), without dropping. */
async function dragOnto(day: string) {
  const handle = inspector().getAllByRole('radio')[0] as HTMLElement
  fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 })
  fireEvent.pointerMove(document, { pointerId: 1, isPrimary: true, clientX: 60, clientY: 60 })
  fireEvent.pointerMove(document, { pointerId: 1, isPrimary: true, clientX: 520, clientY: 520 })
  const label = new RegExp(`^Move to .*${Number(day.slice(8, 10))} May 2014$`)
  await waitFor(() => expect(document.querySelector('.drag-ghost')).toHaveTextContent(label))
}

describe('Days: zoom and navigation', () => {
  it('the decade view opens a year; ⌘↑/⌘↓ step the zoom', async () => {
    // Arrange
    const ctx = fakeContext()
    await openDays()

    // Act
    fireEvent.keyDown(window, { key: 'ArrowUp', ...mod })
    const year = await screen.findByRole('button', { name: /^2016, \d+ days with a photo$/ })
    expect(screen.getByRole('button', { name: /^2014, / })).toHaveAttribute('aria-current', 'true')
    await userEvent.click(year)

    // Assert
    expect(view()).toMatchObject({ daysZoom: 'year', daysYear: 2016 })
    expect(screen.getByRole('heading', { name: '2016' })).toBeInTheDocument()
    expect(ctx.fillRect).toHaveBeenCalled()

    // Act + Assert: ⌘↓ twice reaches month and stays there.
    fireEvent.keyDown(window, { key: 'ArrowDown', ...mod })
    fireEvent.keyDown(window, { key: 'ArrowDown', ...mod })
    expect(view().daysZoom).toBe('month')
    fireEvent.keyDown(window, { key: 'ArrowUp', ...mod })
    fireEvent.keyDown(window, { key: 'ArrowUp', ...mod })
    fireEvent.keyDown(window, { key: 'ArrowUp', ...mod })
    expect(view().daysZoom).toBe('decade')
  })

  it('the year stepper and [ ] change the year, kept within the library', async () => {
    // Arrange
    await openDays()
    const years = (await call('get_days')).map((d) => Number(d.dayKey.slice(0, 4)))
    const firstYear = Math.min(...years)

    // Act + Assert
    await userEvent.click(screen.getByRole('button', { name: 'Next year' }))
    expect(view().daysYear).toBe(2015)
    await userEvent.click(screen.getByRole('button', { name: 'Previous year' }))
    expect(view().daysYear).toBe(2014)
    fireEvent.keyDown(window, { key: ']' })
    expect(view().daysYear).toBe(2015)
    for (let i = 0; i < 20; i++) fireEvent.keyDown(window, { key: '[' })
    expect(view().daysYear).toBe(firstYear)
  })

  it('the month view steps a month at a time', async () => {
    // Arrange
    await openDays()
    await userEvent.click(screen.getByRole('radio', { name: 'Month' }))
    expect(screen.getByRole('region', { name: 'May 2014' })).toBeInTheDocument()

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }))

    // Assert
    expect(view().activeDay).toBe('2014-06-01')
    expect(screen.getByRole('region', { name: 'June 2014' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(view().activeDay).toBe('2014-04-01')
  })

  it('“Find a date” jumps to a valid date only', async () => {
    // Arrange
    await openDays()
    await userEvent.click(screen.getByRole('button', { name: 'Find a date' }))
    const popover = within(screen.getByRole('dialog', { name: 'Go to a date' }))
    const input = popover.getByRole('textbox', { name: 'Date' })

    // Act
    await userEvent.type(input, '2015-02-30')
    const leapDisabled = (popover.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled
    await userEvent.clear(input)
    await userEvent.type(input, '2015-13-45')
    const goDisabled = (popover.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    const stayed = view().activeDay
    await userEvent.clear(input)
    await userEvent.type(input, '2015-06-01{Enter}')

    // Assert
    expect(leapDisabled).toBe(true)
    expect(goDisabled).toBe(true)
    expect(stayed).toBe('2014-05-02')
    expect(view().activeDay).toBe('2015-06-01')
    expect(screen.queryByRole('dialog', { name: 'Go to a date' })).toBeNull()
  })

  it('the days around the selection can be picked', async () => {
    // Arrange
    await openDays()

    // Act
    await userEvent.click(inspector().getByRole('button', { name: /4 May 2014$/ }))

    // Assert
    expect(view().activeDay).toBe('2014-05-04')
  })

  it('the ribbon loupe shows the photo of a hovered day', async () => {
    // Arrange
    stubLayout(365, 34)
    const { container } = await openDays()
    const focus = container.querySelector('.ribbon-track') as HTMLElement

    // Act
    fireEvent.pointerMove(focus, { pointerId: 1, clientX: 1.5 })

    // Assert
    const img = container.querySelector('.ribbon-loupe img')
    const pick = dayOf('2014-01-02')
    if (pick) expect(img?.getAttribute('src')).toMatch(/thumb\/.+\?w=160&v=/)
    else expect(img).toBeNull()
    fireEvent.pointerMove(focus, { pointerId: 1, clientX: 364.5 })
  })
})

describe('Days: choosing photos', () => {
  it('↑/↓ cycle through a day’s photos and digits pick one', async () => {
    // Arrange
    const target = await openDayWithAlternates()
    const [first, second] = target.photoIds

    // Act + Assert
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(dayOf(target.dayKey)?.selectedId).toBe(target.photoIds[(target.photoIds.indexOf(target.selectedId) + 1) % target.photoIds.length]))
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    await waitFor(() => expect(dayOf(target.dayKey)?.selectedId).toBe(target.selectedId))
    fireEvent.keyDown(window, { key: '2' })
    await waitFor(() => expect(dayOf(target.dayKey)?.selectedId).toBe(second))
    await userEvent.click(inspector().getAllByRole('radio')[0] as HTMLElement)
    await waitFor(() => expect(dayOf(target.dayKey)?.selectedId).toBe(first))
  })

  it('a failing choice is reported as a toast', async () => {
    // Arrange
    await openDayWithAlternates({ fail: { select_day_photo: 'io' } })

    // Act
    fireEvent.keyDown(window, { key: '2' })

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.io)).toBeInTheDocument()
  })

  it('leaving a day out from the inspector, and failures, are reported', async () => {
    // Arrange
    const { backend } = await openDays()

    // Act
    await userEvent.click(inspector().getByRole('button', { name: /Leave this day out/ }))

    // Assert
    await waitFor(() => expect(dayOf('2014-05-02')?.excluded).toBe(true))
    backend.configure({ fail: { set_day_excluded: 'permissionDenied' } })
    fireEvent.keyDown(window, { key: 'X' })
    expect(await screen.findByText(DEFAULT_MESSAGES.permissionDenied)).toBeInTheDocument()
  })

  it('adding a photo uses the picked file; a cancelled dialog adds nothing', async () => {
    // Arrange
    const { backend } = await openDays({ cancelDialogs: true })
    const before = dayOf('2014-05-02')?.photoIds.length ?? 0

    // Act
    await userEvent.click(inspector().getByRole('button', { name: /Add a photo to this day/ }))
    backend.configure({ cancelDialogs: false })
    await userEvent.click(inspector().getByRole('button', { name: /Add a photo to this day/ }))

    // Assert
    await waitFor(() => expect(dayOf('2014-05-02')?.photoIds.length).toBe(before + 1))
  })

  it('a failing add is reported as a toast', async () => {
    // Arrange
    await openDays({ fail: { add_photo_to_day: 'unsupportedFormat' } })

    // Act
    await userEvent.click(inspector().getByRole('button', { name: /Add a photo to this day/ }))

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.unsupportedFormat)).toBeInTheDocument()
  })
})

describe('Days: moving photos', () => {
  it('move mode steps by week with ↑/↓ and Escape cancels it', async () => {
    // Arrange
    await openDays()
    await userEvent.click(inspector().getByRole('button', { name: /Move a photo to another day/ }))
    const banner = await screen.findByText(/^Moving the photo from/)

    // Act
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    const target = banner.querySelector('strong')?.textContent
    fireEvent.keyDown(window, { key: 'q' })
    fireEvent.keyDown(window, { key: 'Escape' })

    // Assert
    expect(target).toMatch(/26 Apr/)
    expect(screen.queryByText(/^Moving the photo from/)).toBeNull()
    expect(view().activeDay).toBe('2014-05-02')
  })

  it('a moved photo can be moved back with Undo', async () => {
    // Arrange
    await openDays()
    const photo = dayOf('2014-05-02')?.selectedId as string
    fireEvent.keyDown(window, { key: 'm' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })

    // Act
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => expect(view().activeDay).toBe('2014-05-04'))
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))

    // Assert
    await waitFor(() => expect(view().activeDay).toBe('2014-05-02'))
    await waitFor(() => expect(dayOf('2014-05-02')?.photoIds).toContain(photo))
  })

  it('moving onto the same day does nothing, and a failing move is reported', async () => {
    // Arrange
    const { backend } = await openDays()
    fireEvent.keyDown(window, { key: 'm' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.queryByText(/^Moving the photo from/)).toBeNull()

    // Act
    backend.configure({ fail: { move_photo_to_day: 'io' } })
    fireEvent.keyDown(window, { key: 'm' })
    fireEvent.keyDown(window, { key: 'Enter' })

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.io)).toBeInTheDocument()
    expect(view().activeDay).toBe('2014-05-02')
  })

  it('a photo dragged onto another day moves there', async () => {
    // Arrange
    stubDragGeometry('2014-05-10')
    await openDays()
    const photo = dayOf('2014-05-02')?.selectedId as string

    // Act
    await dragOnto('2014-05-10')
    fireEvent.pointerUp(document, { pointerId: 1, isPrimary: true, clientX: 520, clientY: 520 })

    // Assert
    await waitFor(() => expect(dayOf('2014-05-10')?.photoIds).toContain(photo))
    expect(await screen.findByText(/^Moved to /)).toBeInTheDocument()
  })

  // Regression (M18): Esc cancelled the drag but left the drop-target ring on the day.
  it('Escape during a drag clears the drop target and moves nothing', async () => {
    // Arrange
    stubDragGeometry('2014-05-10')
    await openDays()
    const photo = dayOf('2014-05-02')?.selectedId as string
    await dragOnto('2014-05-10')
    expect(document.querySelector('[data-day="2014-05-10"]')).toHaveAttribute('data-over', 'true')

    // Act
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' })

    // Assert
    await waitFor(() => expect(document.querySelector('.drag-ghost')).toBeNull())
    expect(document.querySelector('[data-over="true"]')).toBeNull()
    expect(dayOf('2014-05-10')?.photoIds ?? []).not.toContain(photo)
  })

  // Regression: dnd-kit's document listeners outlive the screen, so a drag left open used to move the photo on the next pointer-up.
  it('a drag still open when Days unmounts moves nothing', async () => {
    // Arrange
    stubDragGeometry('2014-05-10')
    const { backend, unmount } = await openDays()
    await dragOnto('2014-05-10')
    const handle = vi.spyOn(backend, 'handle')

    // Act
    unmount()
    fireEvent.pointerUp(document, { pointerId: 1, isPrimary: true, clientX: 520, clientY: 520 })
    await act(async () => {
      await Promise.resolve()
    })

    // Assert
    expect(handle.mock.calls.map(([cmd]) => cmd)).not.toContain('move_photo_to_day')
  })

  // L2: only the pointer sensor exists, so no "press space to pick up" and no lost radio role.
  it('alternates stay radios without keyboard-drag instructions; drags are announced by date', async () => {
    // Arrange
    stubDragGeometry('2014-05-10')
    await openDays()
    const radio = inspector().getAllByRole('radio')[0] as HTMLElement

    // Act
    await dragOnto('2014-05-10')

    // Assert
    expect(radio).not.toHaveAttribute('aria-roledescription')
    expect(radio).not.toHaveAttribute('aria-describedby')
    expect(inspector().getByRole('radiogroup')).toContainElement(radio)
    expect(await screen.findByText('Over 10 May 2014.')).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    expect(await screen.findByText('Move cancelled.')).toBeInTheDocument()
  })
})

describe('Days: the calendar grid (L1)', () => {
  const cell = (day: string) => document.querySelector(`[role="gridcell"][data-day="${day}"]`) as HTMLElement

  it('each month is a labelled grid of week rows and day cells', async () => {
    // Arrange + Act
    await openDays()

    // Assert
    expect(screen.getAllByRole('grid')).toHaveLength(12)
    const may = screen.getByRole('grid', { name: 'May 2014' })
    const rows = within(may).getAllByRole('row')
    expect(rows).toHaveLength(5)
    for (const row of rows) expect(within(row).getAllByRole('gridcell')).toHaveLength(7)
    const selected = within(may).getByRole('gridcell', { name: /^Friday 2 May 2014, \d+ photos?/ })
    expect(selected).toHaveAttribute('aria-selected', 'true')
    expect(selected).toHaveAttribute('tabindex', '0')
    expect(screen.getAllByRole('gridcell').filter((c) => c.tabIndex === 0)).toEqual([selected])
  })

  it('←/→ move focus with the active day, into the next month', async () => {
    // Arrange
    await openDays({}, '2014-05-31')
    cell('2014-05-31').focus()

    // Act
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })

    // Assert
    await waitFor(() => expect(document.activeElement).toBe(cell('2014-06-01')))
    expect(view().activeDay).toBe('2014-06-01')
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    await waitFor(() => expect(document.activeElement).toBe(cell('2014-05-31')))
  })

  it('in the month view focus follows into the next month as it renders', async () => {
    // Arrange
    await openDays({}, '2014-05-31')
    await userEvent.click(screen.getByRole('radio', { name: 'Month' }))
    cell('2014-05-31').focus()

    // Act
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' })

    // Assert
    expect(await screen.findByRole('grid', { name: 'June 2014' })).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(cell('2014-06-01')))
  })

  it('arrows leave focus alone when it is elsewhere, e.g. in the inspector', async () => {
    // Arrange
    await openDays()
    const leaveOut = inspector().getByRole('button', { name: /Leave this day out/ })
    leaveOut.focus()

    // Act
    fireEvent.keyDown(leaveOut, { key: 'ArrowRight' })

    // Assert
    await waitFor(() => expect(view().activeDay).toBe('2014-05-03'))
    expect(document.activeElement).toBe(inspector().getByRole('button', { name: /Leave this day out/ }))
  })

  it('with focus on a cell, digits pick, Space selects, and M, arrows, Enter move the photo', async () => {
    // Arrange
    const target = await openDayWithAlternates()
    cell(target.dayKey).focus()
    const focused = () => document.activeElement as HTMLElement

    // Act + Assert: a digit picks the second photo.
    fireEvent.keyDown(focused(), { key: '2' })
    await waitFor(() => expect(dayOf(target.dayKey)?.selectedId).toBe(target.photoIds[1]))

    // Act + Assert: Esc leaves move mode without moving.
    fireEvent.keyDown(focused(), { key: 'm' })
    expect(await screen.findByText(/^Moving the photo from/)).toBeInTheDocument()
    fireEvent.keyDown(focused(), { key: 'Escape' })
    expect(screen.queryByText(/^Moving the photo from/)).toBeNull()

    // Act + Assert: M, →, Enter moves it to the next day.
    fireEvent.keyDown(focused(), { key: 'm' })
    fireEvent.keyDown(focused(), { key: 'ArrowRight' })
    const enter = fireEvent.keyDown(focused(), { key: 'Enter' })
    expect(enter).toBe(false)
    expect(await screen.findByText(/^Moved to /)).toBeInTheDocument()

    // Act + Assert: Space on another cell selects that day.
    const other = cell('2014-05-04')
    other.focus()
    fireEvent.keyDown(other, { key: ' ' })
    expect(view().activeDay).toBe('2014-05-04')
  })

  it('a year without the active day still has one tab stop', async () => {
    // Arrange
    await openDays()

    // Act
    fireEvent.keyDown(window, { key: ']' })

    // Assert
    await screen.findByRole('grid', { name: 'May 2015' })
    const stops = screen.getAllByRole('gridcell').filter((c) => c.tabIndex === 0)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toHaveAttribute('data-day', '2015-01-01')
  })
})

describe('Days: rendering cost (M12)', () => {
  it('toasts and other view-store changes do not re-render the screen', async () => {
    // Arrange
    resetStores()
    installMockBackend({ scenario: 'aligned', speed: 'instant' })
    const onRender = vi.fn()
    render(
      <QueryClientProvider client={queryClient}>
        <Profiler id="days" onRender={onRender}>
          <DaysScreen />
        </Profiler>
      </QueryClientProvider>,
    )
    await screen.findByRole('complementary', { name: 'Selected day' })
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    await waitFor(() => expect(view().activeDay).not.toBeNull())
    const before = onRender.mock.calls.length

    // Act
    act(() => {
      view().pushToast({ message: 'Unrelated', tone: 'info' })
      view().setScanFilter('confirmed')
      view().setExportOpen(false)
      view().toggleSidebar()
    })

    // Assert
    expect(onRender.mock.calls.length).toBe(before)
  })

  it('choosing another day does not redraw the decade rows', async () => {
    // Arrange
    const ctx = fakeContext()
    await openDays()
    fireEvent.keyDown(window, { key: 'ArrowUp', ...mod })
    await screen.findByRole('button', { name: /^2014, / })
    const drawn = ctx.fillRect.mock.calls.length

    // Act
    await act(async () => view().setActiveDay('2014-05-09'))

    // Assert
    expect(ctx.fillRect.mock.calls.length).toBe(drawn)
  })
})

describe('Days: aligning', () => {
  it('the alignment settings change size, backdrop and landmarks, then align again', async () => {
    // Arrange
    await openDays()
    await userEvent.click(screen.getByRole('button', { name: /^Alignment settings: / }))
    const popover = within(screen.getByRole('dialog', { name: 'Alignment' }))

    // Act
    await userEvent.click(popover.getByRole('radio', { name: '720p' }))
    await userEvent.click(popover.getByRole('radio', { name: 'Blur' }))
    await userEvent.click(popover.getByRole('switch', { name: /Refine landmarks/ }))
    await userEvent.click(popover.getByRole('button', { name: 'Align again' }))

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Timelapse'), { timeout: 5000 })
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull())
    expect(session().render).toEqual({ resolution: '720p', backdrop: 'blurred', refineLandmarks: false })
  })

  it('Open Timelapse and ⌘↩ go to the timelapse once frames exist', async () => {
    // Arrange
    await openDays()

    // Act
    await userEvent.click(screen.getByRole('button', { name: /Open Timelapse/ }))

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Timelapse'))
    fireEvent.keyDown(window, { key: '4', ...mod })
    await screen.findByRole('complementary', { name: 'Selected day' })
    fireEvent.keyDown(window, { key: 'Enter', ...mod })
    await waitFor(() => expect(title()).toHaveTextContent('Timelapse'))
  })

  it('before the first align, ⌘↩ aligns the active days', async () => {
    // Arrange
    await renderApp({ scenario: 'reviewed' })
    fireEvent.keyDown(window, { key: '4', ...mod })
    const align = await screen.findByRole('button', { name: /^Align [\d,]+ days/ })
    await userEvent.click(screen.getByRole('button', { name: /^Alignment settings: / }))
    const popover = within(screen.getByRole('dialog', { name: 'Alignment' }))
    expect(popover.queryByRole('button', { name: 'Align again' })).toBeNull()
    await userEvent.click(popover.getByRole('radio', { name: 'Black' }))
    fireEvent.keyDown(window, { key: 'Escape' })

    // Act
    expect(align).toBeEnabled()
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Timelapse'), { timeout: 5000 })
    await waitFor(() => expect(useJobs.getState().activeJobId).toBeNull())
    expect(session().render.backdrop).toBe('black')
  })

  it('an align that cannot start is reported as a toast', async () => {
    // Arrange
    await renderApp({ scenario: 'reviewed', fail: { start_align: 'modelUnavailable' } })
    fireEvent.keyDown(window, { key: '4', ...mod })

    // Act
    await userEvent.click(await screen.findByRole('button', { name: /^Align [\d,]+ days/ }))

    // Assert
    expect(await screen.findByText(MODELS_MISSING)).toBeInTheDocument()
  })
})

// Signature moment 3 (critique round 4): the print becomes the film, so the player opens on the selected day.
describe('opening the timelapse from Days', () => {
  it('opens the player on the selected day’s frame', async () => {
    // Arrange
    await openDays({}, '2014-05-02')
    const frames = await queryClient.fetchQuery({ queryKey: queryKeys.frames, queryFn: () => call('get_frames') })
    const at = frames.frames.findIndex((f) => f.dayKey === '2014-05-02')
    expect(at).toBeGreaterThan(0)

    // Act
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.frames)).toBeDefined())
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Timelapse'))
    expect(usePlayer.getState().index).toBe(at)
  })
})

// Critique round 4, P2-20: a failed align was a 4 s toast only.
describe('a failed align', () => {
  it('stays said above the calendar until the next align', async () => {
    await openDays()
    act(() => useJobs.setState((s) => ({ align: { ...s.align, error: { kind: 'io', message: 'The disk is full.' } } })))
    expect(await screen.findByText('Aligning stopped.')).toBeInTheDocument()
    expect(screen.getByText(/The disk is full\. The frames aligned so far are kept/)).toBeInTheDocument()
    act(() => useJobs.setState((s) => ({ align: { ...s.align, error: null } })))
    expect(screen.queryByText('Aligning stopped.')).toBeNull()
  })
})
