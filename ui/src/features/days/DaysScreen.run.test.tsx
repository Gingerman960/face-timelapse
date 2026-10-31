// Critique round 6, P1-4: Days range selection. ⇧-click and ⇧←/⇧→ extend a run
// of days from the selected one; X (or the inspector's row) leaves the run out
// or puts it back, with one Undo; a plain click, a plain arrow or Esc ends it.
import { afterEach, describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DayGroup } from '../../ipc/contract'
import { DEFAULT_MESSAGES } from '../../ipc/mock/errors'
import { renderApp } from '../../test/renderApp'
import { setDayExcluded } from '../../state/actions'
import { queryClient, queryKeys } from '../../state/queries'
import { useJobs } from '../../state/jobs'
import { useView } from '../../state/view'

const mod = { metaKey: true, ctrlKey: true }
const view = () => useView.getState()
const days = () => queryClient.getQueryData<DayGroup[]>(queryKeys.days) ?? []
const dayOf = (key: string) => days().find((d) => d.dayKey === key)
const inspector = () => within(screen.getByRole('complementary', { name: 'Selected day' }))
const cell = (key: string) => document.querySelector(`.days-canvas [role="gridcell"][data-day="${key}"]`) as HTMLElement
const runDays = () => [...document.querySelectorAll('.days-canvas [role="gridcell"][data-run="true"]')].map((el) => el.getAttribute('data-day'))
const shiftRight = () => fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true })
const RUN = ['2014-05-02', '2014-05-03', '2014-05-04', '2014-05-05']

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

afterEach(() => {
  useJobs.setState({ activeJobId: null })
})

describe('Days · a run of days', () => {
  it('⇧→ extends a run from the selected day, and a plain arrow ends it', async () => {
    // Arrange
    await openDays()

    // Act
    shiftRight()
    shiftRight()
    shiftRight()

    // Assert: four days, the last one active, named in the inspector; the grid says it holds several.
    await waitFor(() => expect(runDays()).toEqual(RUN))
    expect(view().activeDay).toBe('2014-05-05')
    expect(cell('2014-05-03')).toHaveAttribute('aria-selected', 'true')
    expect(cell('2014-05-03').closest('[role="grid"]')).toHaveAttribute('aria-multiselectable', 'true')
    expect(inspector().getByText('2–5 May 2014')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    await waitFor(() => expect(runDays()).toEqual([]))
    expect(view().activeDay).toBe('2014-05-04')
  })

  it('⇧-click draws the run back to an earlier day; Esc ends it, and so does a plain click', async () => {
    // Arrange
    await openDays()

    // Act
    fireEvent.click(cell('2014-04-29'), { shiftKey: true })

    // Assert
    await waitFor(() => expect(runDays()).toEqual(['2014-04-29', '2014-04-30', '2014-05-01', '2014-05-02']))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(runDays()).toEqual([]))
    expect(view().activeDay).toBe('2014-04-29')

    fireEvent.click(cell('2014-05-01'), { shiftKey: true })
    await waitFor(() => expect(runDays()).toHaveLength(3))
    fireEvent.click(cell('2014-05-06'))
    await waitFor(() => expect(runDays()).toEqual([]))
    expect(view().activeDay).toBe('2014-05-06')
  })

  it('⇧Space on a focused day extends the run too (keyboard parity with ⇧-click)', async () => {
    await openDays()
    fireEvent.keyDown(cell('2014-05-04'), { key: ' ', shiftKey: true })
    await waitFor(() => expect(runDays()).toEqual(['2014-05-02', '2014-05-03', '2014-05-04']))
  })

  it('X leaves the whole run out with one Undo, which puts each day back as it was', async () => {
    // Arrange: 3 May was already out before the run.
    await openDays()
    await act(async () => {
      await setDayExcluded('2014-05-03', true)
    })
    const withPhotos = RUN.filter((k) => dayOf(k))
    shiftRight()
    shiftRight()
    shiftRight()
    await waitFor(() => expect(runDays()).toEqual(RUN))

    // Act
    fireEvent.keyDown(window, { key: 'x' })

    // Assert
    await waitFor(() => expect(withPhotos.every((k) => dayOf(k)?.excluded)).toBe(true))
    expect(await screen.findByText(`Left ${withPhotos.length - 1} days out`)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1)

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(dayOf('2014-05-02')?.excluded).toBe(false))
    expect(dayOf('2014-05-03')?.excluded).toBe(true)
    expect(withPhotos.filter((k) => k !== '2014-05-03').every((k) => dayOf(k)?.excluded === false)).toBe(true)
  })

  it('once every day of the run is out, the inspector row puts them all back', async () => {
    // Arrange
    await openDays()
    shiftRight()
    shiftRight()
    fireEvent.keyDown(window, { key: 'X' })
    await waitFor(() => expect(inspector().getByRole('button', { name: /Put these 3 days back in/ })).toBeInTheDocument())

    // Act
    await userEvent.click(inspector().getByRole('button', { name: /Put these 3 days back in/ }))

    // Assert
    await waitFor(() => expect(['2014-05-02', '2014-05-03', '2014-05-04'].every((k) => dayOf(k)?.excluded !== true)).toBe(true))
    expect(await screen.findByText('Put 3 days back in')).toBeInTheDocument()
  })

  it('rests while a job runs, and a refusal is reported with no Undo', async () => {
    // Arrange
    const { backend } = await openDays()
    shiftRight()
    await waitFor(() => expect(runDays()).toHaveLength(2))

    // Act: a job is running.
    act(() => useJobs.setState({ activeJobId: 'job-1' }))
    fireEvent.keyDown(window, { key: 'x' })

    // Assert
    expect(inspector().getByRole('button', { name: /Leave these 2 days out/ })).toBeDisabled()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(dayOf('2014-05-02')?.excluded).toBe(false)

    // Act: the job ends, but the backend refuses.
    act(() => useJobs.setState({ activeJobId: null }))
    backend.configure({ fail: { set_day_excluded: 'permissionDenied' } })
    fireEvent.keyDown(window, { key: 'x' })

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.permissionDenied)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})
