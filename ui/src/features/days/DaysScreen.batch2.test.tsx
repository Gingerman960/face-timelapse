// Days, QA batch 2: M7 (excluded wording), P1-2 (empty months), P1-3 (header and
// ribbon follow the screen), P2-8 (after-midnight link), P2-10 (Decade faces),
// P2-12 (alignment settings), HIGH-3 (far months drop their images).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DayGroup } from '../../ipc/contract'
import { formatDay } from '../../lib/dates'
import { renderApp } from '../../test/renderApp'
import { stubLayout } from '../../test/layout'
import { queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'

const mod = { metaKey: true, ctrlKey: true }
const view = () => useView.getState()
const days = () => queryClient.getQueryData<DayGroup[]>(queryKeys.days) ?? []
const dayOf = (key: string) => days().find((d) => d.dayKey === key)
const inspector = () => within(screen.getByRole('complementary', { name: 'Selected day' }))
const headline = () => document.querySelector('.year-head h2')?.textContent ?? ''
const summary = () => document.querySelector('.year-head .year-sum')?.textContent ?? ''
/** Days a summary accounts for: in the timelapse, left out and empty. */
const daysCounted = (text: string) =>
  [/(\d+) in the timelapse/, /(\d+) left out/, /(\d+) empty/].reduce((sum, re) => sum + Number(re.exec(text)?.[1] ?? 0), 0)
const canvasImgs = () => document.querySelectorAll('.days-canvas .face img').length

async function openDays(day = '2014-05-02', opts: Parameters<typeof renderApp>[0] = {}) {
  const app = await renderApp({ scenario: 'aligned', ...opts })
  fireEvent.keyDown(window, { key: '4', ...mod })
  await screen.findByRole('complementary', { name: 'Selected day' })
  await act(async () => {
    view().setActiveDay(day)
    view().setDaysYear(Number(day.slice(0, 4)))
  })
  return app
}

/** A controllable IntersectionObserver: tests decide which observed elements are on (or near) the screen. */
class FakeObserver {
  static all: FakeObserver[] = []
  readonly targets = new Set<Element>()
  constructor(
    private readonly cb: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeObserver.all.push(this)
  }
  observe(el: Element) {
    this.targets.add(el)
  }
  unobserve(el: Element) {
    this.targets.delete(el)
  }
  disconnect() {
    this.targets.clear()
  }
  takeRecords() {
    return []
  }
  /** Reports every observed element; `on` decides which intersect. */
  report(on: (el: Element) => boolean) {
    const entries = [...this.targets].map((target) => ({ target, isIntersecting: on(target) }) as IntersectionObserverEntry)
    act(() => this.cb(entries, this as unknown as IntersectionObserver))
  }
}

/** The observer watching the year view's month sections with the given root margin. */
function monthObserver(margin: 'near' | 'visible'): FakeObserver {
  const found = FakeObserver.all.find(
    (o) => [...o.targets].some((t) => t.matches('section.month')) && (margin === 'near') === (o.options.rootMargin ?? '').includes('100%'),
  )
  if (!found) throw new Error(`no ${margin} month observer`)
  return found
}
const monthOf = (el: Element) => Number(el.getAttribute('data-month'))

afterEach(() => {
  vi.unstubAllGlobals()
  FakeObserver.all = []
})

describe('M7: an excluded day never says "In the timelapse"', () => {
  it('the chosen photo of a left-out day reads "Left out with the day"', async () => {
    // Arrange
    await openDays()

    // Act
    fireEvent.keyDown(window, { key: 'x' })
    await waitFor(() => expect(dayOf('2014-05-02')?.excluded).toBe(true))

    // Assert
    expect(inspector().queryByText('In the timelapse')).toBeNull()
    expect(inspector().getByText('Left out with the day')).toBeInTheDocument()
    expect(inspector().getAllByRole('radio')[0]).toHaveAccessibleName(/left out with the day$/)
    // Critique round 2: no red loop on a pick that isn't in the timelapse; the summary counts it.
    expect(document.querySelector('.alt-card .mark')).toBeNull()
    expect(summary()).toMatch(/^\d+ in the timelapse · 1 left out/)

    // Act + Assert: putting the day back restores the label and the loop.
    fireEvent.keyDown(window, { key: 'x' })
    expect(await inspector().findByText('In the timelapse')).toBeInTheDocument()
    expect(inspector().queryByText('Left out with the day')).toBeNull()
    expect(document.querySelector('.alt-card .mark')).not.toBeNull()
  })
})

describe('P1-2: months outside the library collapse into one line', () => {
  it('the first year starts at the first photo, the last year ends at the last one', async () => {
    // Arrange
    await openDays()
    const first = days()[0]?.dayKey as string
    const last = days().at(-1)?.dayKey as string
    const firstMonth = Number(first.slice(5, 7))
    const lastMonth = Number(last.slice(5, 7))

    // Act
    await act(async () => view().setDaysYear(Number(first.slice(0, 4))))

    // Assert
    expect(screen.getByText(`No photos before ${formatDay(first)}`)).toBeInTheDocument()
    expect(screen.getAllByRole('grid')).toHaveLength(12 - firstMonth + 1)
    const opening = screen.getAllByRole('grid')[0] as HTMLElement
    expect(within(opening).getAllByRole('row').every((r) => within(r).getAllByRole('gridcell').length === 7)).toBe(true)

    // Act + Assert: the last year.
    await act(async () => view().setDaysYear(Number(last.slice(0, 4))))
    expect(screen.getByText(`No photos after ${formatDay(last)}`)).toBeInTheDocument()
    expect(screen.getAllByRole('grid')).toHaveLength(lastMonth)
    expect(screen.queryByText(/^No photos before/)).toBeNull()
  })

  it('a year inside the library keeps all twelve months', async () => {
    // Arrange + Act
    await openDays()

    // Assert
    expect(screen.getAllByRole('grid')).toHaveLength(12)
    expect(screen.queryByText(/^No photos (before|after)/)).toBeNull()
  })
})

describe('P1-3: the header and the ribbon follow what is on screen', () => {
  it('Month zoom headlines the month and counts its days', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()

    // Act
    await user.click(screen.getByRole('radio', { name: 'Month' }))

    // Assert
    expect(headline()).toBe('May 2014')
    expect(summary()).toMatch(/^\d+ in the timelapse/)
    expect(daysCounted(summary())).toBe(31)

    // Act + Assert: in move mode it follows the target into April.
    fireEvent.keyDown(window, { key: 'm' })
    for (let i = 0; i < 4; i++) fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(headline()).toBe('April 2014')
    expect(daysCounted(summary())).toBe(30)
    expect(document.querySelector('.ribbon-label')).toHaveTextContent('2014')
  })

  it('the ribbon marks the month in Month zoom and the move target as its cursor', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays('2014-12-30')

    // Act
    await user.click(screen.getByRole('radio', { name: 'Month' }))

    // Assert: December is the last 31 of 365 days.
    const mark = document.querySelector('.ribbon-visible') as HTMLElement
    expect(parseFloat(mark.style.left)).toBeCloseTo((334 / 365) * 100, 3)
    expect(parseFloat(mark.style.width)).toBeCloseTo((31 / 365) * 100, 3)

    // Act + Assert: moving into January 2015 moves the focus year and the cursor.
    fireEvent.keyDown(window, { key: 'm' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(document.querySelector('.ribbon-label')).toHaveTextContent('2015')
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '1 January 2015')
  })

  it('in Year zoom the ribbon marks the months scrolled into view', async () => {
    // Arrange
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    await openDays()

    // Act: April to June are on screen.
    monthObserver('visible').report((el) => monthOf(el) >= 4 && monthOf(el) <= 6)

    // Assert: 1 April is day 90 of 2014, and April to June are 91 days.
    const mark = document.querySelector('.ribbon-visible') as HTMLElement
    expect(parseFloat(mark.style.left)).toBeCloseTo((90 / 365) * 100, 3)
    expect(parseFloat(mark.style.width)).toBeCloseTo((91 / 365) * 100, 3)
    expect(headline()).toBe('2014')
  })
})

describe('P2-8: the after-midnight move sits inside its photo’s card', () => {
  it('reads "Taken after midnight · Move to 1 May" inside the card, outside the radio', async () => {
    // Arrange + Act
    await openDays()

    // Assert
    const move = inspector().getByRole('button', { name: 'Move to 1 May 2014' })
    expect(move).toHaveTextContent(/^Move to 1 May$/)
    const card = move.closest('.alt-card') as HTMLElement
    expect(card).toHaveTextContent(/Taken after midnight · Move to 1 May/)
    const radio = within(card).getByRole('radio')
    expect(radio).not.toContainElement(move)
    expect(radio).toHaveAccessibleName(/taken after midnight/)
  })
})

describe('Contract v1.4: a photo without a time of day', () => {
  it('reads its date, never "00:00", and is not offered as taken after midnight', async () => {
    // Arrange + Act: the mock's last day is a date-only file name (IMG_20220831.jpg).
    await openDays('2022-08-31')

    // Assert
    const radio = inspector().getByRole('radio')
    const card = radio.closest('.alt-card') as HTMLElement
    expect(card.querySelector('.alt-meta strong')).toHaveTextContent(/^31 Aug$/)
    expect(card).not.toHaveTextContent(/00:00|after midnight/)
    expect(radio).toHaveAccessibleName(/^Photo taken 31 Aug, likeness/)
    expect(inspector().queryByRole('button', { name: /^Move to/ })).toBeNull()
  })

  it('keeps the time of a photo that has one', async () => {
    await openDays()
    const times = inspector().getAllByRole('radio').map((r) => r.closest('.alt-card')?.querySelector('.alt-meta strong')?.textContent)
    expect([...times].sort()).toEqual(['00:41', '08:41', '12:23'])
  })
})

describe('P2-10: Decade zoom is a strip of weekly faces per year', () => {
  it('draws 53 weeks per year with month hairlines; a face opens Year zoom at its week', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()

    // Act
    await user.click(screen.getByRole('radio', { name: 'Decade' }))

    // Assert
    const row = (screen.getByRole('button', { name: /^2014, / }).closest('.decade-row') as HTMLElement)
    const weeks = row.querySelectorAll('.wk')
    expect(weeks).toHaveLength(53)
    expect(row.querySelectorAll('.wk[data-month-start]')).toHaveLength(11)
    const face = row.querySelector('.wk img') as HTMLImageElement
    expect(face.getAttribute('src')).toMatch(/[?&]w=160(&|$)/)
    expect(row.querySelector('.decade-weeks')).toHaveAttribute('aria-hidden', 'true')

    // Act: the face of the week that starts on 5 March (day 63 of 2014).
    const march = row.querySelector('.wk[data-week="9"]') as HTMLElement
    const day = march.getAttribute('data-day') as string
    await user.click(march)

    // Assert
    expect(day >= '2014-03-05' && day <= '2014-03-11').toBe(true)
    expect(view()).toMatchObject({ daysZoom: 'year', activeDay: day, daysYear: 2014 })
  })

  it('a narrow strip shows one face per two weeks, so faces stay faces', async () => {
    // Arrange: 500 px for 53 weeks would be 9 px faces.
    stubLayout(500, 400)
    const user = userEvent.setup()
    await openDays()

    // Act
    await user.click(screen.getByRole('radio', { name: 'Decade' }))

    // Assert
    const row = screen.getByRole('button', { name: /^2014, / }).closest('.decade-row') as HTMLElement
    expect(row.querySelectorAll('.wk')).toHaveLength(27)
    expect((row.querySelector('.wk[data-day]') as HTMLElement).title).toMatch(/^Two weeks from /)
  })

  it('weeks outside the library are blank and weeks without a photo are empty frames', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()
    const first = days()[0]?.dayKey as string

    // Act
    await user.click(screen.getByRole('radio', { name: 'Decade' }))

    // Assert
    const row = screen.getByRole('button', { name: new RegExp(`^${first.slice(0, 4)}, `) }).closest('.decade-row') as HTMLElement
    expect(row.querySelector('.wk[data-week="0"]')).toHaveClass('out')
    expect(row.querySelectorAll('.wk.out img')).toHaveLength(0)
    expect(row.querySelectorAll('.wk.empty img')).toHaveLength(0)
  })
})

describe('P2-12: the alignment settings say what they are set to', () => {
  it('a labelled trigger shows the values; the popover labels its rows', async () => {
    // Arrange
    const user = userEvent.setup()
    await renderApp({ scenario: 'reviewed' })
    fireEvent.keyDown(window, { key: '4', ...mod })
    const trigger = await screen.findByRole('button', { name: /^Alignment settings: / })
    expect(trigger).toHaveTextContent(/^1080p$/)
    expect(trigger).toHaveAccessibleName('Alignment settings: 1080p · Extend edges')

    // Act
    await user.click(trigger)
    const popover = within(screen.getByRole('dialog', { name: 'Alignment' }))
    await user.click(popover.getByRole('radio', { name: 'Black' }))

    // Assert
    expect(popover.getByText('Frame size', { selector: '.render-label' })).toBeInTheDocument()
    expect(popover.getByText('Outside the photo', { selector: '.render-label' })).toBeInTheDocument()
    expect(trigger).toHaveTextContent(/^1080p$/)
    expect(trigger).toHaveAccessibleName('Alignment settings: 1080p · Black')
  })

  it('once aligned, the same trigger opens the settings with Align again', async () => {
    // Arrange
    const user = userEvent.setup()
    await openDays()

    // Act
    await user.click(screen.getByRole('button', { name: /^Alignment settings: / }))

    // Assert
    expect(within(screen.getByRole('dialog', { name: 'Alignment' })).getByRole('button', { name: 'Align again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Align again…' })).toBeNull()
  })
})

describe('HIGH-3: far-off months let go of their images', () => {
  it('only months within a screen of the view keep their images; the grid stays whole', async () => {
    // Arrange
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    await openDays()
    const cells = screen.getAllByRole('gridcell').length
    const near = monthObserver('near')
    expect(near.options.rootMargin).toBe('100% 0px')

    // Act: April to June are near the screen.
    near.report((el) => monthOf(el) >= 4 && monthOf(el) <= 6)
    const spring = canvasImgs()

    // Act: scrolled to the end of the year.
    near.report((el) => monthOf(el) >= 10)
    const autumn = canvasImgs()

    // Assert
    const photos = (from: string, to: string) => days().filter((d) => d.dayKey >= from && d.dayKey <= to).length
    expect(spring).toBe(photos('2014-04-01', '2014-06-30'))
    expect(autumn).toBe(photos('2014-10-01', '2014-12-31'))
    expect(screen.getAllByRole('gridcell')).toHaveLength(cells)
    expect(screen.getByRole('grid', { name: 'May 2014' })).toBeInTheDocument()
  })
})

// UI review 2, M3: ←/→ on a focused photo changed the day and dropped focus to <body>.
describe('the inspector photos are radios the arrows move between', () => {
  it('→ and ← choose the next and previous photo and keep focus on it', async () => {
    // Arrange: 2 May 2014 has three photos.
    await openDays()
    const radios = () => inspector().getAllByRole('radio')
    const chosenBefore = dayOf('2014-05-02')?.selectedId
    const start = radios().find((r) => r.getAttribute('aria-checked') === 'true') as HTMLElement
    start.focus()
    const at = radios().indexOf(start)

    // Act
    fireEvent.keyDown(start, { key: 'ArrowRight' })

    // Assert
    await waitFor(() => expect(dayOf('2014-05-02')?.selectedId).not.toBe(chosenBefore))
    expect(view().activeDay).toBe('2014-05-02')
    const next = radios()[(at + 1) % 3] as HTMLElement
    expect(document.activeElement).toBe(next)
    fireEvent.keyDown(next, { key: 'ArrowLeft' })
    await waitFor(() => expect(dayOf('2014-05-02')?.selectedId).toBe(chosenBefore))
    expect(view().activeDay).toBe('2014-05-02')
    expect(document.activeElement).toBe(radios()[at])
  })
})

// UI review 2, L3: holding ↓ kept choosing the same photo while the cache caught up.
describe('↓ pressed twice quickly', () => {
  it('moves the pick two photos on', async () => {
    // Arrange: each choice answers after 80 ms.
    const { backend } = await openDays()
    const handle = backend.handle
    Object.defineProperty(backend, 'handle', {
      value: async (cmd: string, payload?: unknown) => {
        if (cmd === 'select_day_photo') await new Promise((resolve) => setTimeout(resolve, 80))
        return handle(cmd, payload)
      },
    })
    const group = dayOf('2014-05-02') as DayGroup
    const at = group.photoIds.indexOf(group.selectedId)

    // Act
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'ArrowDown' })

    // Assert
    await waitFor(() => expect(dayOf('2014-05-02')?.selectedId).toBe(group.photoIds[(at + 2) % 3]))
  })
})

// Critique round 5, P2-19: the after-midnight note sat about 45 pt below its card.
describe('P2-19: the after-midnight move is the card’s own third line', () => {
  it('sits in the card’s lines, under the likeness, while the radio still covers the card', async () => {
    await openDays()
    const move = inspector().getByRole('button', { name: 'Move to 1 May 2014' })
    const meta = move.closest('.alt-meta') as HTMLElement
    expect(meta).not.toBeNull()
    const lines = Array.from(meta.children).map((el) => el.className)
    expect(lines.indexOf('alt-note')).toBeGreaterThan(0)
    const card = meta.closest('.alt-card') as HTMLElement
    expect(within(card).getByRole('radio')).toHaveClass('alt')
  })
})
