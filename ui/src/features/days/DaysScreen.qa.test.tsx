// Regressions from the real-app QA pass (QA 8, 11, 12, 13, 15, 25, 31).
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DayGroup } from '../../ipc/contract'
import { call } from '../../ipc/client'
import { renderApp } from '../../test/renderApp'
import { queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'
import { MONTH_NAMES } from './daysModel'

const mod = { metaKey: true, ctrlKey: true }
const view = () => useView.getState()
const days = () => queryClient.getQueryData<DayGroup[]>(queryKeys.days) ?? []
const dayOf = (key: string) => days().find((d) => d.dayKey === key)
const inspectorRegion = () => screen.queryByRole('complementary', { name: 'Selected day' })
const yearHeading = (year: number | string) => screen.queryByRole('heading', { level: 2, name: String(year) })
const moveTarget = () => document.querySelector('.move-banner strong')?.textContent ?? ''
const monthName = (day: string) => `${MONTH_NAMES[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`

async function openDays(day = '2014-05-02') {
  const app = await renderApp({ scenario: 'aligned' })
  fireEvent.keyDown(window, { key: '4', ...mod })
  await screen.findByRole('complementary', { name: 'Selected day' })
  await act(async () => {
    view().setActiveDay(day)
    view().setDaysYear(Number(day.slice(0, 4)))
  })
  return app
}

describe('Days QA 8: move mode owns its keys', () => {
  it('arrows and Enter drive the move target, not a zoom control focused by a click', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()
    const photo = dayOf('2014-05-02')?.selectedId as string
    fireEvent.keyDown(window, { key: 'm' })
    await screen.findByText(/^Moving the photo from/)
    const month = screen.getByRole('radio', { name: 'Month' })
    await user.click(month)
    expect(month).toHaveFocus()

    // Act
    await user.keyboard('{ArrowRight}{ArrowRight}')

    // Assert: the zoom stayed on Month and the target moved two days on from 3 May.
    expect(view().daysZoom).toBe('month')
    expect(screen.getByRole('radio', { name: 'Month' })).toHaveAttribute('aria-checked', 'true')
    expect(moveTarget()).toMatch(/5 May 2014/)

    // Act + Assert: Enter on the focused radio moves the photo to the chosen day.
    await user.keyboard('{Enter}')
    await waitFor(() => expect(dayOf('2014-05-05')?.photoIds).toContain(photo))
    expect(view().daysZoom).toBe('month')
  })

  it('takes the arrows from the ribbon range, and Enter and Esc from a focused button', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()
    fireEvent.keyDown(window, { key: 'm' })
    await screen.findByText(/^Moving the photo from/)
    const ribbon = screen.getByRole('slider')
    ribbon.focus()

    // Act
    await user.keyboard('{ArrowRight}{ArrowDown}')

    // Assert: → a day, ↓ a week, and the active day did not move.
    expect(moveTarget()).toMatch(/11 May 2014/)
    expect(view().activeDay).toBe('2014-05-02')

    // Act + Assert: Esc on a focused inspector button cancels the move, and the button isn't pressed by Enter later.
    const leaveOut = within(inspectorRegion() as HTMLElement).getByRole('button', { name: /Leave this day out/ })
    leaveOut.focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByText(/^Moving the photo from/)).toBeNull()
    fireEvent.keyDown(window, { key: 'm' })
    await screen.findByText(/^Moving the photo from/)
    leaveOut.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByText(/^Moving the photo from/)).toBeNull())
    expect(dayOf('2014-05-02')?.excluded).toBe(false)
  })

  it('leaves a text field its own keys while moving', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()
    fireEvent.keyDown(window, { key: 'm' })
    await screen.findByText(/^Moving the photo from/)
    await user.click(screen.getByRole('button', { name: 'Find a date' }))
    const input = screen.getByRole('textbox', { name: 'Date' })

    // Act
    await user.type(input, '2015{ArrowLeft}')

    // Assert
    expect(moveTarget()).toMatch(/3 May 2014/)
  })
})

describe('Days QA 11: landing year', () => {
  it('lands on the most recent year, on its last day, with that month scrolled into view', async () => {
    // Arrange
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')

    // Act: from a screen that selects no day (the player selects the day on show, below).
    await renderApp({ scenario: 'scanned' })
    fireEvent.keyDown(window, { key: '4', ...mod })
    await screen.findByRole('complementary', { name: 'Selected day' })

    // Assert
    const last = days().at(-1)?.dayKey as string
    const year = Number(last.slice(0, 4))
    await waitFor(() => expect(view().activeDay).toBe(last))
    expect(view().daysYear).toBe(year)
    expect(yearHeading(year)).toBeInTheDocument()
    const month = screen.getByRole('region', { name: monthName(last) })
    await waitFor(() => expect(scrolled.mock.contexts).toContain(month))
  })

  // Critique round 5, P1-2: Timelapse → Days shrinks the frame on show into its own day's cell.
  it('from the player, lands on the day on show', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    fireEvent.keyDown(window, { key: 'End' })
    const shown = await waitFor(() => {
      const day = view().activeDay
      expect(day).toBe(days().at(-1)?.dayKey)
      return day as string
    })

    // Act
    fireEvent.keyDown(window, { key: '4', ...mod })
    await screen.findByRole('complementary', { name: 'Selected day' })

    // Assert
    expect(view().activeDay).toBe(shown)
    expect(view().daysYear).toBe(Number(shown.slice(0, 4)))
  })

  it('lands on the selected day’s year even when another year was viewed before', async () => {
    // Arrange: the timelapse's "Replace this day's photo" selects a day; an older visit left 2014 in view.
    await renderApp({ scenario: 'aligned' })
    await act(async () => {
      view().setDaysYear(2014)
      view().setActiveDay('2018-03-10')
    })

    // Act
    fireEvent.keyDown(window, { key: '4', ...mod })
    await screen.findByRole('complementary', { name: 'Selected day' })

    // Assert
    await waitFor(() => expect(yearHeading(2018)).toBeInTheDocument())
    expect(view().daysYear).toBe(2018)
    expect(screen.getByRole('grid', { name: 'March 2018' })).toBeInTheDocument()
  })
})

describe('Days QA 15: the year numeral shows the year on screen', () => {
  it('in month zoom it is the month on screen, whatever year the store remembers', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays('2014-12-30')
    await user.click(screen.getByRole('radio', { name: 'Month' }))

    // Act
    await act(async () => view().setDaysYear(2015))

    // Assert
    expect(screen.getByRole('grid', { name: 'December 2014' })).toBeInTheDocument()
    expect(yearHeading('December 2014')).toBeInTheDocument()
    expect(yearHeading(2015)).toBeNull()
  })

  it('[ and ] in month zoom step the month a year, keeping the header in step', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays('2014-12-30')
    await user.click(screen.getByRole('radio', { name: 'Month' }))

    // Act
    fireEvent.keyDown(window, { key: ']' })

    // Assert
    expect(await screen.findByRole('grid', { name: 'December 2015' })).toBeInTheDocument()
    expect(yearHeading('December 2015')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Month' })).toHaveTextContent('Dec 2015')
  })

  it('in move mode the view and the header follow the target into the next year', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays('2014-12-30')
    await user.click(screen.getByRole('radio', { name: 'Month' }))
    fireEvent.keyDown(window, { key: 'm' })
    await screen.findByText(/^Moving the photo from/)

    // Act: the target starts on 31 Dec; one more day is 1 Jan 2015.
    fireEvent.keyDown(window, { key: 'ArrowRight' })

    // Assert
    expect(await screen.findByRole('grid', { name: 'January 2015' })).toBeInTheDocument()
    expect(yearHeading('January 2015')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Month' })).toHaveTextContent('Jan 2015')

    // Act + Assert: in year zoom too; Esc returns to the day being moved from.
    await user.click(screen.getByRole('radio', { name: 'Year' }))
    expect(yearHeading(2015)).toBeInTheDocument()
    expect(screen.getByRole('grid', { name: 'January 2015' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(await screen.findByRole('grid', { name: 'December 2014' })).toBeInTheDocument()
    expect(yearHeading(2014)).toBeInTheDocument()
  })

  it('in move mode the toolbar stepper moves the target a month at a time', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays('2014-05-02')
    await user.click(screen.getByRole('radio', { name: 'Month' }))
    fireEvent.keyDown(window, { key: 'm' })
    await screen.findByText(/^Moving the photo from/)

    // Act
    await user.click(screen.getByRole('button', { name: 'Next month' }))

    // Assert
    expect(moveTarget()).toMatch(/3 Jun 2014/)
    expect(view().activeDay).toBe('2014-05-02')
    expect(screen.getByRole('grid', { name: 'June 2014' })).toBeInTheDocument()
  })
})

describe('Days: pointer paths', () => {
  it('clicking a day cell selects that day', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()

    // Act
    await user.click(document.querySelector('[role="gridcell"][data-day="2014-05-09"]') as HTMLElement)

    // Assert
    expect(view().activeDay).toBe('2014-05-09')
  })

  it('“Move to 1 May” puts a photo taken after midnight on the day before', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()
    const late = dayOf('2014-05-02')?.photoIds.length ?? 0

    // Act
    await user.click(within(inspectorRegion() as HTMLElement).getByRole('button', { name: 'Move to 1 May 2014' }))

    // Assert
    await waitFor(() => expect(dayOf('2014-05-02')?.photoIds.length).toBe(late - 1))
    expect(await screen.findByText(/^Moved to 1 May 2014/)).toBeInTheDocument()
  })
})

describe('Days QA 31: the plate counts the days that need aligning', () => {
  it('reads "Re-align 1 day" when one day changed, and every day when all frames are stale', async () => {
    // Arrange
    await openDays()
    expect(screen.getByRole('button', { name: /^Open Timelapse/ })).toBeInTheDocument()

    // Act: choosing another photo for one day leaves one frame to render.
    fireEvent.keyDown(window, { key: '2' })

    // Assert
    expect(await screen.findByRole('button', { name: /^Re-align 1 day(?!s)/ })).toBeInTheDocument()

    // Act: a new crop makes every frame stale.
    await call('set_reference_crop', { crop: { x: 700, y: 0, width: 1776, height: 2368 }, aspect: '3:4' })
    await act(async () => {
      await queryClient.invalidateQueries()
    })

    // Assert
    const expected = (await call('get_session')).frames.expected
    expect(await screen.findByRole('button', { name: new RegExp(`^Re-align ${expected.toLocaleString('en-US')} days`) })).toBeInTheDocument()
  })
})

describe('Days QA 25: the inspector follows ⌥⌘I', () => {
  it('⌥⌘I and the toolbar toggle hide and show the Days inspector', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()
    const toggle = screen.getByRole('button', { name: 'Toggle inspector' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    // Act
    fireEvent.keyDown(window, { key: 'i', code: 'KeyI', altKey: true, ...mod })

    // Assert
    expect(view().inspectorOpen).toBe(false)
    expect(inspectorRegion()).toBeNull()
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle)
    expect(view().inspectorOpen).toBe(true)
    expect(inspectorRegion()).toBeInTheDocument()
  })
})

describe('Days QA 12: the toolbar centre keeps its layout', () => {
  it('shows the stepper in every zoom, so the zoom control never shifts', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()

    // Act + Assert
    for (const zoom of ['Decade', 'Year', 'Month'] as const) {
      await user.click(screen.getByRole('radio', { name: zoom }))
      const nav = document.querySelector('.days-nav') as HTMLElement
      expect(nav).toBeInTheDocument()
      expect(within(nav).getAllByRole('button')).toHaveLength(2)
    }
  })

  it('in decade zoom the stepper moves the current year', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()
    await user.click(screen.getByRole('radio', { name: 'Decade' }))

    // Act
    await user.click(screen.getByRole('button', { name: 'Next year' }))

    // Assert
    expect(view().daysYear).toBe(2015)
    expect(screen.getByRole('button', { name: /^2015, / })).toHaveAttribute('aria-current', 'true')
  })
})

describe('Days QA 13: alternates fanned out in month zoom', () => {
  it('fans up to two alternates behind the chosen face, from small thumbnails', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()
    const many = days().find((d) => d.dayKey.startsWith('2014-05') && d.photoIds.length > 2) as DayGroup
    const single = days().find((d) => d.dayKey.startsWith('2014-05') && d.photoIds.length === 1) as DayGroup

    // Act
    await user.click(screen.getByRole('radio', { name: 'Month' }))

    // Assert
    const cell = document.querySelector(`[data-day="${many.dayKey}"]`) as HTMLElement
    const cards = cell.querySelectorAll('.fan-card')
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(card).toHaveAttribute('aria-hidden', 'true')
      expect(card.querySelector('img')?.getAttribute('src')).toMatch(/[?&]w=160(&|$)/)
    }
    // The count is generated content, so the cell's visible text stays its day number (axe label-content-name-mismatch).
    expect(cell.querySelector('.alt-count')).toHaveAttribute('data-count', String(many.photoIds.length))
    expect(cell.querySelector('.alt-count')).toBeEmptyDOMElement()
    expect(document.querySelector(`[data-day="${single.dayKey}"] .fan-card`)).toBeNull()

    // Act + Assert: the year view stays a plain grid.
    await user.click(screen.getByRole('radio', { name: 'Year' }))
    expect(document.querySelector('.fan-card')).toBeNull()
  })
})

// UI review 2, M6: while moving a photo, a click selected the day instead of retargeting the move.
describe('move mode takes clicks, the ribbon and Find as the target', () => {
  it('clicking a day retargets the move, and Enter moves the photo there', async () => {
    // Arrange
    await openDays()
    const photo = dayOf('2014-05-02')?.selectedId as string
    fireEvent.keyDown(window, { key: 'm' })
    await screen.findByText(/^Moving the photo from/)

    // Act
    fireEvent.click(document.querySelector('[data-day="2014-05-13"]') as HTMLElement)

    // Assert
    expect(moveTarget()).toMatch(/13 May 2014/)
    expect(view().activeDay).toBe('2014-05-02')
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => expect(dayOf('2014-05-13')?.photoIds).toContain(photo))
  })

  it('a seek on the ribbon retargets the move too', async () => {
    await openDays()
    fireEvent.keyDown(window, { key: 'm' })
    await screen.findByText(/^Moving the photo from/)
    const ribbon = within(screen.getByRole('contentinfo', { name: 'Ten years of days' }))
    // The ribbon's cursor follows the move target (3 May); three days later is 6 May.
    const slider = ribbon.getByRole('slider') as HTMLInputElement
    fireEvent.change(slider, { target: { value: String(Number(slider.value) + 3) } })
    expect(moveTarget()).toMatch(/6 May 2014/)
    expect(view().activeDay).toBe('2014-05-02')
  })
})
