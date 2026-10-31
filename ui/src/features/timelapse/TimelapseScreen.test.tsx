import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FramesView, SessionSnapshot } from '../../ipc/contract'
import { call } from '../../ipc/client'
import type { MockOptions } from '../../ipc/mock/install'
import { DEFAULT_MESSAGES } from '../../ipc/mock/errors'
import { renderApp } from '../../test/renderApp'
import { stubLayout } from '../../test/layout'
import { withRetryParam } from '../../components/ui/RetryImg'
import { resetSession, setDayExcluded, setLook } from '../../state/actions'
import { startAlign, useJobs } from '../../state/jobs'
import { usePlayer } from '../../state/player'
import { libraryReplaced, queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'
import { parseClamped } from './FrameInspector'
import { formatShortDate, weekdayOf } from '../../lib/dates'
import { formatVideoLength, frameIndexForDay } from './timelapseModel'

const frames = () => queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames ?? []
const session = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session) as SessionSnapshot
const title = () => screen.getByRole('heading', { level: 1 })
/** Even light on (exposure), as N would. */
const setLookOn = () => setLook({ normalize: 'exposure', strength: 0.7 })

async function openTimelapse(opts: Partial<MockOptions> = {}) {
  const app = await renderApp({ scenario: 'aligned', ...opts })
  await screen.findByRole('toolbar', { name: 'Playback' })
  await act(async () => usePlayer.getState().setIndex(0))
  return app
}

describe('parseClamped', () => {
  it('reads commas and typographic minus signs and clamps to the range', () => {
    expect(parseClamped('1,5', -5, 5)).toBe(1.5)
    expect(parseClamped('−30', -20, 20)).toBe(-20)
    expect(parseClamped('300', 50, 200)).toBe(200)
    expect(parseClamped('abc', 0, 1)).toBeNull()
  })
})

describe('frameIndexForDay', () => {
  it('finds the first frame on or after a day', () => {
    // Arrange
    const list = ['2014-01-01', '2014-01-03', '2014-01-05'].map((dayKey) => ({ dayKey }) as FramesView['frames'][number])

    // Act + Assert
    expect(frameIndexForDay(list, '2014-01-02')).toBe(1)
    expect(frameIndexForDay(list, '2014-01-05')).toBe(2)
    expect(frameIndexForDay(list, '2015-01-01')).toBe(2)
    expect(frameIndexForDay([], '2014-01-01')).toBe(0)
  })
})

// QA 25: ⌥⌘I flipped the shared inspector field while the Timelapse kept its own.
describe('Frame inspector toggle (QA 25)', () => {
  const inspector = () => screen.queryByRole('complementary', { name: 'Frame' })
  const toggle = () => screen.getByRole('button', { name: 'Toggle frame inspector' })

  it('⌥⌘I and the toolbar button flip the one shared inspector field', async () => {
    // Arrange
    await openTimelapse()
    const initial = useView.getState().inspectorOpen
    expect(inspector() !== null).toBe(initial)
    expect(toggle()).toHaveAttribute('aria-pressed', String(initial))

    // Act
    fireEvent.keyDown(window, { key: 'ˆ', code: 'KeyI', altKey: true, metaKey: true })

    // Assert
    expect(useView.getState().inspectorOpen).toBe(!initial)
    expect(inspector() !== null).toBe(!initial)
    expect(toggle()).toHaveAttribute('aria-pressed', String(!initial))

    // Act
    await userEvent.click(toggle())

    // Assert
    expect(useView.getState().inspectorOpen).toBe(initial)
    expect(inspector() !== null).toBe(initial)
  })

  it('follows the field when another screen changed it', async () => {
    // Arrange
    await openTimelapse()

    // Act + Assert
    act(() => useView.setState({ inspectorOpen: false }))
    expect(inspector()).toBeNull()
    act(() => useView.setState({ inspectorOpen: true }))
    expect(inspector()).not.toBeNull()
  })
})

describe('Frame inspector', () => {
  async function openInspector(opts: Partial<MockOptions> = {}) {
    const app = await openTimelapse(opts)
    if (!useView.getState().inspectorOpen) await userEvent.click(screen.getByRole('button', { name: 'Toggle frame inspector' }))
    const inspector = within(screen.getByRole('complementary', { name: 'Frame' }))
    return { ...app, inspector }
  }

  async function commit(input: HTMLElement, text: string): Promise<void> {
    await userEvent.clear(input)
    await userEvent.type(input, `${text}{Enter}`)
  }

  it('nudges the frame, clamped to each field’s range, and resets the nudge', async () => {
    // Arrange
    const { inspector } = await openInspector()
    const id = frames()[0]?.photoId
    const adjust = () => frames().find((f) => f.photoId === id)?.adjust
    const reset = inspector.getByRole('button', { name: /Reset the nudge/ })
    expect(reset).toBeDisabled()

    // Act
    await commit(inspector.getByRole('textbox', { name: 'Move across, percent of the width' }), '40')
    await waitFor(() => expect(adjust()?.dx).toBe(0.25))
    await commit(inspector.getByRole('textbox', { name: 'Move down, percent of the height' }), '-2')
    await waitFor(() => expect(adjust()?.dy).toBe(-0.02))
    await commit(inspector.getByRole('textbox', { name: 'Scale, percent' }), '10')
    await waitFor(() => expect(adjust()?.scale).toBe(0.5))
    await commit(inspector.getByRole('textbox', { name: 'Rotate, degrees' }), '3.5')
    await waitFor(() => expect(adjust()?.rotationDeg).toBe(3.5))

    // Assert
    expect(inspector.getByRole('textbox', { name: 'Move across, percent of the width' })).toHaveValue('25.0')
    expect(inspector.getByRole('textbox', { name: 'Scale, percent' })).toHaveValue('50')

    // Act
    await userEvent.click(inspector.getByRole('button', { name: /Reset the nudge/ }))

    // Assert
    await waitFor(() => expect(adjust()).toEqual({ dx: 0, dy: 0, scale: 1, rotationDeg: 0 }))
  })

  it('ignores text that is not a number', async () => {
    // Arrange
    const { inspector } = await openInspector()
    const before = frames()[0]?.adjust

    // Act
    for (const name of ['Move across, percent of the width', 'Move down, percent of the height', 'Scale, percent', 'Rotate, degrees']) {
      await commit(inspector.getByRole('textbox', { name }), 'x')
    }

    // Assert
    expect(frames()[0]?.adjust).toEqual(before)
  })

  it('a failed nudge is reported as a toast', async () => {
    // Arrange
    const { inspector } = await openInspector({ fail: { set_frame_adjustment: 'io' } })

    // Act
    await commit(inspector.getByRole('textbox', { name: 'Rotate, degrees' }), '2')

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.io)).toBeInTheDocument()
  })

  it('“Use another photo” opens that day in Days', async () => {
    // Arrange
    const { inspector } = await openInspector()
    const day = frames()[0]?.dayKey

    // Act
    await userEvent.click(inspector.getByRole('button', { name: /Use another photo for this day/ }))

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Days'))
    expect(useView.getState().activeDay).toBe(day)
  })

  it('“Leave this day out” excludes the day', async () => {
    // Arrange
    const { inspector } = await openInspector()
    const day = frames()[0]?.dayKey

    // Act
    await userEvent.click(inspector.getByRole('button', { name: /Leave this day out/ }))

    // Assert
    await waitFor(async () => expect((await call('get_days')).find((d) => d.dayKey === day)?.excluded).toBe(true))
  })

  it('a failed exclusion is reported as a toast', async () => {
    // Arrange
    const { inspector } = await openInspector({ fail: { set_day_excluded: 'permissionDenied' } })

    // Act
    await userEvent.click(inspector.getByRole('button', { name: /Leave this day out/ }))

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.permissionDenied)).toBeInTheDocument()
  })
})

describe('Transport', () => {
  // QA N4: one pace, in days a second, shared with the ledger and the export sheet.
  it('the pace popover sets the days a second everywhere: the transport, the ledger and the export', async () => {
    // Arrange
    await openTimelapse()
    const toolbar = within(screen.getByRole('toolbar', { name: 'Playback' }))
    const ledger = within(screen.getByRole('navigation', { name: 'Project' }))
    expect(ledger.getByText('1:59 · 30 days/s')).toBeInTheDocument()
    await userEvent.click(toolbar.getByRole('button', { name: 'Pace 30 days/s' }))
    const popover = screen.getByRole('dialog', { name: 'Pace' })

    // Act
    await userEvent.click(within(popover).getByRole('radio', { name: '10' }))

    // Assert
    expect(toolbar.getByRole('button', { name: 'Pace 10 days/s' })).toBeInTheDocument()
    expect(ledger.getByText('5:56 · 10 days/s')).toBeInTheDocument()
    // Critique round 4, item 4: the transport prints the length as the ledger does.
    expect(toolbar.getByText('/ 5:56', { exact: false })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'e' })
    const sheet = within(await screen.findByRole('dialog', { name: 'Export timelapse' }))
    expect(sheet.getByRole('textbox', { name: 'Days a second' })).toHaveValue('10')
    expect(sheet.getByRole('textbox', { name: 'Duration' })).toHaveValue('5:55.7')
  })

  it('the onion popover picks the source, opacity and difference, turning onion skin on', async () => {
    // Arrange
    await openTimelapse()
    await userEvent.click(screen.getByRole('button', { name: 'Onion skin settings' }))
    const popover = within(screen.getByRole('dialog', { name: 'Onion skin' }))

    // Act
    await userEvent.click(popover.getByRole('radio', { name: 'Reference' }))
    fireEvent.change(popover.getByRole('slider'), { target: { value: '30' } })
    fireEvent.pointerUp(popover.getByRole('slider'))
    await userEvent.click(popover.getByRole('switch', { name: /Difference/ }))

    // Assert
    expect(useView.getState()).toMatchObject({ onion: true, onionSource: 'reference', onionOpacity: 0.3, onionDifference: true })
    expect(popover.getByText('30%')).toBeInTheDocument()
  })

  // Critique round 4, P1-2: Onion skin and Even light are the caption's Look pair now.
  it('the Onion chip in the caption’s Look pair turns onion skin on and off', async () => {
    // Arrange
    await openTimelapse()
    const chip = () => within(screen.getByRole('group', { name: 'Look' })).getByRole('button', { name: 'Onion' })

    // Act + Assert
    await userEvent.click(chip())
    expect(useView.getState().onion).toBe(true)
    expect(chip()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Onion skin: previous day at 50%')).toBeInTheDocument()
    await userEvent.click(chip())
    expect(useView.getState().onion).toBe(false)
  })

  it('the even-light popover chooses what to even out and how strongly', async () => {
    // Arrange
    await openTimelapse()
    await userEvent.click(screen.getByRole('button', { name: 'Even light settings' }))
    const popover = within(screen.getByRole('dialog', { name: 'Even out light' }))
    expect(popover.queryByText(/and white balance/)).toBeNull()

    // Act: moving the strength turns the look on in the last mode.
    fireEvent.change(popover.getByRole('slider'), { target: { value: '40' } })
    await waitFor(() => expect(session().look).toEqual({ normalize: 'exposureAndColor', strength: 0.4 }))
    expect(popover.getByText(/and white balance/)).toBeInTheDocument()
    await userEvent.click(popover.getByRole('radio', { name: 'Exposure' }))

    // Assert
    await waitFor(() => expect(session().look.normalize).toBe('exposure'))
    expect(popover.queryByText(/and white balance/)).toBeNull()
    expect(await screen.findByRole('img', { name: /^Face exposure moved from zone 5 to / })).toBeInTheDocument()
    expect(document.querySelector('.cap-evened .meta')).toHaveTextContent(/^(Brightened|Darkened) \d*[⅓⅔]? stops?$|^Already even$/)
  })

  // Regression (H7): every onChange used to call set_look, re-rendering every frame per tick.
  it('dragging Strength keeps a local draft and commits once on release', async () => {
    // Arrange
    const { backend } = await openTimelapse()
    const handle = vi.spyOn(backend, 'handle')
    const lookCalls = () => handle.mock.calls.filter(([cmd]) => cmd === 'set_look').map(([, args]) => args)
    await userEvent.click(screen.getByRole('button', { name: 'Even light settings' }))
    const popover = within(screen.getByRole('dialog', { name: 'Even out light' }))
    const slider = popover.getByRole('slider')

    // Act: a drag is a burst of change events.
    for (const value of ['41', '42', '43', '44']) fireEvent.change(slider, { target: { value } })

    // Assert: the slider follows the drag, nothing is sent yet.
    expect(slider).toHaveValue('44')
    expect(popover.getByText('44%')).toBeInTheDocument()
    expect(lookCalls()).toHaveLength(0)

    // Act: release.
    fireEvent.pointerUp(slider)

    // Assert: one request with the final value.
    await waitFor(() => expect(session().look).toEqual({ normalize: 'exposureAndColor', strength: 0.44 }))
    expect(lookCalls()).toEqual([{ look: { normalize: 'exposureAndColor', strength: 0.44 } }])
    fireEvent.blur(slider)
    expect(lookCalls()).toHaveLength(1)
  })

  it('Strength commits after a short pause and on key release', async () => {
    // Arrange
    const { backend } = await openTimelapse()
    const handle = vi.spyOn(backend, 'handle')
    const lookCalls = () => handle.mock.calls.filter(([cmd]) => cmd === 'set_look').length
    await userEvent.click(screen.getByRole('button', { name: 'Even light settings' }))
    const slider = within(screen.getByRole('dialog', { name: 'Even out light' })).getByRole('slider')

    // Act + Assert: a change with no release still lands after the debounce.
    fireEvent.change(slider, { target: { value: '55' } })
    expect(lookCalls()).toBe(0)
    await waitFor(() => expect(session().look.strength).toBe(0.55))
    expect(lookCalls()).toBe(1)

    // Act + Assert: a keyboard step commits on key release.
    fireEvent.change(slider, { target: { value: '56' } })
    fireEvent.keyUp(slider, { key: 'ArrowRight' })
    await waitFor(() => expect(session().look.strength).toBe(0.56))
    expect(lookCalls()).toBe(2)
  })

  it('dragging onion Opacity keeps a local draft and commits on release', async () => {
    // Arrange
    await openTimelapse()
    await userEvent.click(screen.getByRole('button', { name: 'Onion skin settings' }))
    const popover = within(screen.getByRole('dialog', { name: 'Onion skin' }))
    const slider = popover.getByRole('slider')

    // Act
    for (const value of ['20', '25', '30']) fireEvent.change(slider, { target: { value } })

    // Assert
    expect(popover.getByText('30%')).toBeInTheDocument()
    expect(useView.getState().onionOpacity).toBe(0.5)

    // Act
    fireEvent.pointerUp(slider)

    // Assert
    expect(useView.getState()).toMatchObject({ onion: true, onionOpacity: 0.3 })
  })

  it('Even light remembers the last mode when toggled back on', async () => {
    // Arrange
    await openTimelapse()
    await userEvent.click(screen.getByRole('button', { name: 'Even light settings' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Exposure' }))
    await waitFor(() => expect(session().look.normalize).toBe('exposure'))
    fireEvent.keyDown(window, { key: 'Escape' })
    const chip = screen.getByRole('button', { name: /Even light/ , pressed: true })

    // Act
    await userEvent.click(chip)
    await waitFor(() => expect(session().look.normalize).toBe('off'))
    await userEvent.click(screen.getByRole('button', { name: /Even light/, pressed: false }))

    // Assert
    await waitFor(() => expect(session().look.normalize).toBe('exposure'))
  })

  it('steps, shuttles faster and backwards, and toggles loop from the pace popover', async () => {
    // Arrange
    await openTimelapse()

    // Act + Assert
    await userEvent.click(screen.getByRole('button', { name: 'Next frame' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next frame' }))
    await userEvent.click(screen.getByRole('button', { name: 'Previous frame' }))
    expect(usePlayer.getState().index).toBe(1)

    fireEvent.keyDown(window, { key: 'l' })
    fireEvent.keyDown(window, { key: 'l' })
    expect(screen.getByLabelText('Playback rate 2')).toHaveTextContent('2×')
    fireEvent.keyDown(window, { key: 'j' })
    expect(screen.getByLabelText('Playback rate -1')).toHaveTextContent('−1×')
    fireEvent.keyDown(window, { key: 'k' })

    // Critique round 4, P1-2: the transport plays; Loop lives with the pace.
    expect(within(screen.getByRole('toolbar', { name: 'Playback' })).queryByRole('button', { name: /Loop/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Pace / }))
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Pace' })).getByRole('switch', { name: /Loop/ }))
    expect(usePlayer.getState().loop).toBe(false)
  })

  // Critique round 5, P2-13: no keyboard map anywhere; the transport's tooltips now carry their keys.
  it('names each transport key in its tooltip and as a key shortcut', async () => {
    // Arrange
    await openTimelapse()
    const transport = within(screen.getByRole('toolbar', { name: 'Playback' }))

    // Assert
    expect(transport.getByRole('button', { name: 'Previous frame' })).toHaveAttribute('title', 'Previous frame (←)')
    expect(transport.getByRole('button', { name: 'Previous frame' })).toHaveAttribute('aria-keyshortcuts', 'ArrowLeft')
    expect(transport.getByRole('button', { name: 'Play' })).toHaveAttribute('title', 'Play (Space)')
    expect(transport.getByRole('button', { name: 'Play' })).toHaveAttribute('aria-keyshortcuts', 'Space')
    expect(transport.getByRole('button', { name: 'Next frame' })).toHaveAttribute('title', 'Next frame (→)')
    expect(transport.getByRole('button', { name: 'Next frame' })).toHaveAttribute('aria-keyshortcuts', 'ArrowRight')
    expect(transport.getByRole('button', { name: /^Pace / })).toHaveAttribute('title', 'Pace and loop (J, K, L shuttle)')

    // Act + Assert: the disc's tooltip follows what it does.
    act(() => usePlayer.getState().toggle())
    expect(transport.getByRole('button', { name: 'Pause' })).toHaveAttribute('title', 'Pause (Space)')
    act(() => usePlayer.getState().pause())
  })

  it('the filmstrip jumps to a frame', async () => {
    // Arrange
    await openTimelapse()
    const strip = within(screen.getByRole('listbox', { name: 'Frames near the playhead' }))
    const third = frames()[2]

    // Act
    await userEvent.click(strip.getByRole('option', { name: `Frame 3, ${third?.dayKey}` }))

    // Assert
    expect(usePlayer.getState().index).toBe(2)
    expect(strip.getByRole('option', { name: `Frame 3, ${third?.dayKey}` })).toHaveAttribute('aria-selected', 'true')
  })

  // QA batch 9: "▸ 0002" didn't fit a 42 px film cell and lost its last digit. Only the
  // playhead frame keeps the marker (it has the room); the others print the bare number.
  it('prints bare frame numbers in the filmstrip, with the marker only on the playhead frame', async () => {
    // Arrange
    await openTimelapse()
    const strip = screen.getByRole('listbox', { name: 'Frames near the playhead' })

    // Assert
    const edges = [...strip.querySelectorAll('.film')].map((f) => [f.getAttribute('aria-selected'), f.querySelector('.edge')?.getAttribute('data-n')])
    expect(edges.find(([on]) => on === 'true')?.[1]).toBe('▸ 0001')
    expect(edges.filter(([on]) => on !== 'true').map(([, n]) => n).slice(0, 2)).toEqual(['0002', '0003'])
  })
})

// QA 1: a thumbnail the image server turned away (503 under load) stayed broken.
describe('Thumbnails that fail to load', () => {
  it('a filmstrip frame and a sheet cell are asked for again', async () => {
    // Arrange
    stubLayout()
    await openTimelapse()
    const film = screen.getByRole('option', { name: `Frame 3, ${frames()[2]?.dayKey}` }).querySelector('img') as HTMLImageElement
    const filmSrc = film.getAttribute('src') ?? ''

    // Act
    fireEvent.error(film)

    // Assert
    await waitFor(() => expect(film.getAttribute('src')).toBe(withRetryParam(filmSrc, 1)), { timeout: 2000 })

    // Arrange
    await userEvent.click(screen.getByRole('radio', { name: 'Sheet' }))
    const cell = within(await screen.findByLabelText('All aligned frames')).getAllByRole('button')[0]?.querySelector('img') as HTMLImageElement
    const cellSrc = cell.getAttribute('src') ?? ''

    // Act
    fireEvent.error(cell)

    // Assert
    await waitFor(() => expect(cell.getAttribute('src')).toBe(withRetryParam(cellSrc, 1)), { timeout: 2000 })
  })
})

describe('Rendering while playing (M12)', () => {
  it('the transport timecode follows the settled playhead in video time, not every frame', async () => {
    // Arrange: 30 fps with a 1 s last hold.
    await openTimelapse()
    const timecode = () => document.querySelector('.timecode')?.textContent
    const length = (frames().length + 30) / 30

    // Act: the loop moves the playhead; settled follows at ~4 Hz.
    act(() => usePlayer.setState({ index: 60 }))
    const beforeSettle = timecode()
    act(() => usePlayer.setState({ settled: 60 }))

    // Assert: whole seconds, in the ledger's length format (critique round 4, item 4).
    const total = formatVideoLength(length)
    expect(total).toMatch(/^\d+:\d\d$/)
    expect(beforeSettle).toBe(`0:00 / ${total}`)
    expect(timecode()).toBe(`0:02 / ${total}`)
  })

  // Critique round 5, P2-17: the hero date ticked at the ~4 Hz settle; it follows every frame
  // through a ref (no React render), while the rest of the plate keeps the settle rate.
  it('writes the hero date, year and weekday at frame rate, ahead of the settled facts line', async () => {
    // Arrange
    await openTimelapse()
    const text = (selector: string) => document.querySelector(selector)?.textContent
    const facts = text('.cap-line')

    // Act: the loop moves the playhead; no settle yet.
    act(() => usePlayer.setState({ index: 200 }))

    // Assert
    const day = frames()[200]?.dayKey ?? ''
    expect(text('.cap-date')).toBe(formatShortDate(day))
    expect(text('.cap-year')).toBe(day.slice(0, 4))
    expect(text('.cap-sub')).toBe(weekdayOf(day))
    expect(text('.cap-line')).toBe(facts)
  })

  // Regression (M12): `present` was rebuilt on every render, so both ribbon canvases redrew at the settle rate.
  it('the ribbon canvases do not redraw when only the playhead moves', async () => {
    // Arrange
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    await openTimelapse()
    const before = getContext.mock.calls.length

    // Act: the playhead moves within the same year.
    act(() => usePlayer.setState({ index: 3, settled: 3 }))
    act(() => usePlayer.setState({ index: 6, settled: 6 }))

    // Assert
    expect(getContext.mock.calls.length).toBe(before)
  })
})

describe('Pace and look choices', () => {
  // Regression (L3): a pace seeded from a duration (e.g. 29.81 fps) left the pace popover without a tab stop.
  it('a pace seeded from a duration is its own checked, tabbable choice', async () => {
    // Arrange
    await openTimelapse()
    act(() => {
      queryClient.setQueryData<SessionSnapshot>(queryKeys.session, (s) => (s ? { ...s, video: { ...s.video, pace: { mode: 'duration', seconds: 120 } } } : s))
    })
    // The aligned scenario cuts between days, so days a second equal frames a second.
    const daysPerSecond = Number((frames().length / 119).toFixed(2))

    // Act
    await userEvent.click(await screen.findByRole('button', { name: `Pace ${daysPerSecond} days/s` }))
    const pace = within(screen.getByRole('dialog', { name: 'Pace' }))

    // Assert
    expect(pace.getByRole('radio', { name: String(daysPerSecond) })).toHaveAttribute('aria-checked', 'true')
    expect(pace.getByRole('radio', { name: String(daysPerSecond) })).toHaveAttribute('tabindex', '0')
    expect(pace.getAllByRole('radio').map((r) => r.textContent)).toEqual(['5', '10', '15', '20', '29.81', '30'].map((v) => (v === '29.81' ? String(daysPerSecond) : v)))
  })

  it('a Strength drag still lands when the transport goes away before release', async () => {
    // Arrange
    await openTimelapse()
    await userEvent.click(screen.getByRole('button', { name: 'Even light settings' }))
    const slider = within(screen.getByRole('dialog', { name: 'Even out light' })).getByRole('slider')

    // Act: drag, then switch to the sheet (the transport unmounts) without releasing.
    fireEvent.change(slider, { target: { value: '61' } })
    act(() => useView.getState().setTimelapseMode('grid'))

    // Assert
    await waitFor(() => expect(session().look).toEqual({ normalize: 'exposureAndColor', strength: 0.61 }))
  })
})

describe('Timelapse keys', () => {
  it('⌥ arrows jump a year, Home/End go to the ends, and the viewer opens and closes', async () => {
    // Arrange
    await openTimelapse()
    const first = frames()[0]?.dayKey ?? ''

    // Act + Assert
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
    expect(frames()[usePlayer.getState().index]?.dayKey.slice(0, 4)).toBe(String(Number(first.slice(0, 4)) + 1))
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(window, { key: 'End' })
    expect(usePlayer.getState().index).toBe(frames().length - 1)
    fireEvent.keyDown(window, { key: 'Home' })
    expect(usePlayer.getState().index).toBe(0)

    fireEvent.keyDown(window, { key: 'd' })
    expect(useView.getState()).toMatchObject({ onion: true, onionDifference: true })
    fireEvent.keyDown(window, { key: 'a' })
    expect(useView.getState().anchors).toBe(true)

    fireEvent.keyDown(window, { key: 'f' })
    expect(await screen.findByRole('dialog', { name: 'Full-window viewer' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Full-window viewer' })).toBeNull()
    fireEvent.keyDown(window, { key: 'f' })
    await userEvent.click(await screen.findByRole('dialog', { name: 'Full-window viewer' }))
    expect(usePlayer.getState().viewer).toBe(false)
  })

  it('⌘E and the Export button open the export sheet', async () => {
    // Arrange
    await openTimelapse()

    // Act
    fireEvent.keyDown(window, { key: 'e', metaKey: true, ctrlKey: true })

    // Assert
    expect(await screen.findByRole('dialog', { name: 'Export timelapse' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await userEvent.click(screen.getByRole('button', { name: /^Export…/ }))
    expect(await screen.findByRole('dialog', { name: 'Export timelapse' })).toBeInTheDocument()
  })
})

describe('Frame sheet', () => {
  it('opens a frame from the sheet and sorts by worst fit', async () => {
    // Arrange
    stubLayout()
    await openTimelapse()
    await userEvent.click(screen.getByRole('radio', { name: 'Sheet' }))
    const grid = await screen.findByLabelText('All aligned frames')
    expect(document.querySelector('.sheet-bar .meta')?.textContent).toMatch(/^[\d,]+ days · (all within 3× the median fit|[\d,]+ to check)$/)
    const firstCell = () => within(grid).getAllByRole('button')[0] as HTMLElement
    const before = firstCell().getAttribute('aria-label')

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Worst fit first', pressed: false }))

    // Assert
    expect(screen.getByRole('button', { name: 'Worst fit first', pressed: true })).toBeInTheDocument()
    expect(firstCell().getAttribute('aria-label')).not.toBe(before)
    const worst = Math.max(...frames().map((f) => f.residualPx))
    const target = frames().findIndex((f) => f.residualPx === worst)
    expect(firstCell()).toHaveAccessibleName(new RegExp(`^Frame ${target + 1}, `))

    // Act
    await userEvent.click(firstCell())

    // Assert
    expect(usePlayer.getState().index).toBe(target)
    expect(useView.getState().timelapseMode).toBe('player')
  })
})

describe('Frame sheet layout', () => {
  /** Top of each rendered row, from its transform. */
  const rowTops = (grid: HTMLElement) =>
    [...grid.querySelectorAll<HTMLElement>('.grid-row')].map((r) => Number(/translateY\(([\d.]+)px\)/.exec(r.style.transform)?.[1]))

  /** A ResizeObserver that reports only when the test says so, like a browser after layout. */
  function deferResizeObservers() {
    const observed: Array<() => void> = []
    class DeferredResizeObserver {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(target: Element): void {
        observed.push(() => this.cb([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver))
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    const original = globalThis.ResizeObserver
    globalThis.ResizeObserver = DeferredResizeObserver as unknown as typeof ResizeObserver
    return {
      report: () => act(() => observed.forEach((report) => report())),
      restore: () => {
        globalThis.ResizeObserver = original
      },
    }
  }

  // Regression (M6): rows kept the offsets estimated from the 900 px first guess after the width was measured,
  // so the sheet's first paint depended on when the observer and the frames arrived.
  it('stacks rows at the height of the measured width and the frame aspect, also after a resize', async () => {
    // Arrange
    stubLayout(3000, 800)
    await openTimelapse()
    const { width, height } = session().reference?.crop ?? { width: 3, height: 4 }
    const rowHeight = (w: number, cols: number) => 15 + 3 + ((w - 6 - (cols - 1) * 3) / cols) * (height / width) + 9
    const observers = deferResizeObservers()

    try {
      // Act: the sheet mounts; the observer has not reported yet.
      await userEvent.click(screen.getByRole('radio', { name: 'Sheet' }))
      const grid = await screen.findByLabelText('All aligned frames')

      // Assert: 16 columns at 3000 px from the first render on.
      let tops = rowTops(grid)
      expect(tops.length).toBeGreaterThan(2)
      expect(tops[1]).toBeCloseTo(rowHeight(3000, 16), 6)
      expect(tops[2]).toBeCloseTo(2 * rowHeight(3000, 16), 6)
      expect(within(grid).getAllByRole('button')).toHaveLength(tops.length * 16)

      // Act: the window narrows to 1500 px (15 columns).
      stubLayout(1500, 800)
      observers.report()

      // Assert: rows are re-stacked at the new height.
      tops = rowTops(grid)
      expect(tops[1]).toBeCloseTo(rowHeight(1500, 15), 6)
      expect(tops[2]).toBeCloseTo(2 * rowHeight(1500, 15), 6)
    } finally {
      observers.restore()
    }
  })

  // P2-14: dates on narrow cells ran into the next cell; below 150 px only the frame number is printed.
  it('prints the date on the edge only when a cell is at least 150 px wide', async () => {
    // Arrange: 1200 px gives 12 columns of about 97 px.
    stubLayout(1200, 800)
    await openTimelapse()
    await userEvent.click(screen.getByRole('radio', { name: 'Sheet' }))
    const edges = async () => [...(await screen.findByLabelText('All aligned frames')).querySelectorAll('.grid-cell .edge')]

    // Assert
    const narrow = await edges()
    expect(narrow.length).toBeGreaterThan(0)
    expect(narrow.every((e) => e.hasAttribute('data-n') && !e.hasAttribute('data-day'))).toBe(true)
  })

  it('keeps the date on cells 150 px wide or more', async () => {
    // Arrange: 3000 px gives 16 columns of about 184 px.
    stubLayout(3000, 800)
    await openTimelapse()

    // Act
    await userEvent.click(screen.getByRole('radio', { name: 'Sheet' }))

    // Assert
    const wide = [...(await screen.findByLabelText('All aligned frames')).querySelectorAll('.grid-cell .edge')]
    expect(wide.length).toBeGreaterThan(0)
    expect(wide.every((e) => e.hasAttribute('data-day'))).toBe(true)
  })

  it('renders no rows before the sheet has a width', async () => {
    // Arrange: jsdom lays nothing out, so the width is 0.
    await openTimelapse()

    // Act
    await userEvent.click(screen.getByRole('radio', { name: 'Sheet' }))
    const grid = await screen.findByLabelText('All aligned frames')

    // Assert
    expect(rowTops(grid)).toEqual([])
  })
})

describe('Aligning', () => {
  it('shows progress while aligning, then Stop falls back to Days with a toast', async () => {
    // Arrange
    const { backend } = await openTimelapse()
    backend.configure({ speed: 'fast' })

    // Act
    await act(async () => {
      await startAlign(session().render)
    })

    // Assert
    expect(await screen.findByText(/^Aligning [\d,]+ of [\d,]+$/, { selector: '.row' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Alignment progress' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Player/ })).toBeDisabled()
    expect(screen.getByRole('toolbar', { name: 'Playback' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(window, { key: ' ' })
    expect(usePlayer.getState().playing).toBe(false)

    // Act
    await userEvent.click(screen.getByRole('button', { name: /Stop/ }))

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Days'), { timeout: 3000 })
    expect(await screen.findByText(/^Aligned [\d,]+ of [\d,]+\. Align again to continue\.$/)).toBeInTheDocument()
  })

  it('announces align progress through one throttled live region, then the finish (M11)', async () => {
    // Arrange
    const { backend } = await openTimelapse()
    backend.configure({ speed: 'fast' })

    // Act
    await act(async () => {
      await startAlign(session().render)
    })
    const counter = await screen.findByText(/^Aligning [\d,]+ of [\d,]+$/, { selector: '.row' })

    // Assert: the visual counter is not a live region; the announcer speaks instead.
    const announcer = () => within(screen.getByRole('region', { name: 'Timelapse' })).getByRole('status')
    expect(counter.closest('[aria-live]')).toBeNull()
    expect(announcer()).toHaveTextContent(/^(Aligning started\.|Aligning\. [\d,]+ of [\d,]+ days\.)$/)
    await waitFor(() => expect(announcer()).toHaveTextContent(/^Alignment finished\. [\d,]+ days\.$/), { timeout: 4000 })
  })

  it('lists frames that could not be aligned; a failure links to Days and can be dismissed', async () => {
    // Arrange
    await openTimelapse({ alignFailures: 2 })
    await act(async () => {
      await startAlign({ ...session().render, resolution: '720p' })
    })
    await waitFor(() => expect(useJobs.getState().align.summary).not.toBeNull())
    const status = await screen.findByText(/2 days couldn’t be aligned\./)

    // Act
    await userEvent.click(within(status.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Dismiss' }))

    // Assert
    expect(screen.queryByText(/couldn’t be aligned/)).toBeNull()
  })

  it('a failure message opens Days', async () => {
    // Arrange: a finished align that left one frame out.
    await openTimelapse()
    const failed = [{ photoId: frames()[0]?.photoId ?? '', error: { kind: 'decodeFailed' as const, message: 'IMG_1.jpg couldn’t be read.' } }]
    act(() => {
      useJobs.setState((s) => ({ align: { ...s.align, summary: { jobId: 'align-1', total: 1, rendered: 0, reused: 0, failed, outputSize: { width: 1, height: 1 }, durationMs: 1 } } }))
    })
    expect(screen.getByText(/^1 day couldn’t be aligned\./)).toBeInTheDocument()

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'IMG_1.jpg couldn’t be read.' }))

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Days'))
  })
})

describe('Plate caption', () => {
  const factsLine = () => document.querySelector('.cap-line')

  // Critique round 4, P1-2: one facts line, numbers in the data font only. Round 6, P2-7: counted in days.
  it('reads the chosen day and the count on one facts line', async () => {
    await openTimelapse()
    await act(async () => usePlayer.getState().setIndex(0))
    const n = frames().length
    expect(factsLine()).toHaveTextContent(new RegExp(`^Day 1 of ${n.toLocaleString('en-US')}$`))
    expect([...(factsLine()?.querySelectorAll('.digits') ?? [])].map((d) => d.textContent)).toEqual(['1', n.toLocaleString('en-US')])
    await act(async () => usePlayer.getState().setIndex(1))
    expect(factsLine()).toHaveTextContent(new RegExp(`^Day 2 of ${n.toLocaleString('en-US')}$`))
  })

  // Critique round 4, item 19: the fit has a scale; round 5, P2-12: words first, then the units.
  it('gives the fit its band against the median in words, flagging the sheet’s outliers as loose', async () => {
    await openTimelapse()
    const worst = frames().reduce((w, f, i) => (f.residualPx > (frames()[w]?.residualPx ?? 0) ? i : w), 0)
    await act(async () => usePlayer.getState().setIndex(worst))
    const fit = document.querySelector('.cap-fit') as HTMLElement
    expect(fit).toHaveTextContent(/^(Tightly lined up|Lined up|Loosely lined up) · \d+\.\d px$/)
    expect(fit.querySelector('.digits')).toHaveTextContent(/^\d+\.\d$/)
    const sorted = frames().map((f) => f.residualPx).sort((a, b) => a - b)
    const median = sorted.length % 2 ? (sorted[(sorted.length - 1) / 2] ?? 0) : ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2
    const loose = (frames()[worst]?.residualPx ?? 0) > 3 * median
    expect(fit.dataset.band === 'loose').toBe(loose)
    expect(fit).toHaveTextContent(loose ? /^Loosely/ : /^(Tightly|Lined)/)
    expect(fit.querySelector('.fit-scale')).toHaveAttribute('aria-hidden', 'true')
  })

  // Critique round 5, P2-12: the fit's explanation was a `title` no keyboard could reach.
  it('explains the fit in a popover the keyboard can open, and returns focus on Escape', async () => {
    // Arrange
    await openTimelapse()
    const fit = screen.getByRole('button', { name: /lined up · \d+\.\d px$/i })
    expect(fit).not.toHaveAttribute('title')
    expect(fit).toHaveAttribute('aria-expanded', 'false')

    // Act
    fit.focus()
    await userEvent.keyboard('{Enter}')

    // Assert
    const popover = await screen.findByRole('dialog', { name: 'How well this day lines up' })
    expect(fit).toHaveAttribute('aria-expanded', 'true')
    expect(popover).toHaveTextContent(/median of all frames/)
    expect(popover).toHaveTextContent(/\d+\.\d px/)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'How well this day lines up' })).toBeNull())
    expect(fit).toHaveFocus()
  })

  // Critique round 4, item 24: the wedge is labelled; round 5, P2-12: in words first.
  it('labels the zone wedge from and to in thirds, under the change in words', async () => {
    await openTimelapse()
    await act(async () => {
      await setLookOn()
    })
    const wedge = await screen.findByRole('img', { name: /^Face exposure moved from zone 5 to / })
    const label = wedge.parentElement?.querySelector('.zone-label')
    expect(label?.textContent).toMatch(/^From zone 5 to \d*[⅓⅔]?$/)
    expect(wedge.querySelectorAll('.zone-mark.from')).toHaveLength(1)
    expect(document.querySelector('.cap-evened .meta')?.textContent).not.toMatch(/EV/)
  })
})

// QA 30: at 960×640 the 19-frame strip (870 px) and the transport were wider
// than the player and pushed the toolbar, strip and ribbon past the window.
describe('Narrow player (QA 30)', () => {
  const strip = () => within(screen.getByRole('listbox', { name: 'Frames near the playhead' }))
  const player = () => document.querySelector('.player')

  // Critique round 4, P1-2: the transport is playback only (about 360 px), so it fits every
  // column; the Look pair keeps its names in the caption (it drops only the words, by a
  // container query, when the caption is at its narrowest).
  it('a narrow player shows the frames that fit and the playback-only transport, every control named', async () => {
    // Arrange: 960×640 with the inspector open leaves the player 568 px.
    stubLayout(568, 640)

    // Act
    await openTimelapse()
    await act(async () => usePlayer.getState().setIndex(100))

    // Assert: 11 frames, the playhead in the middle.
    const options = strip().getAllByRole('option')
    expect(options).toHaveLength(11)
    expect(options[5]).toHaveAttribute('aria-selected', 'true')
    expect(options[5]).toHaveAccessibleName(`Frame 101, ${frames()[100]?.dayKey}`)
    const transport = within(screen.getByRole('toolbar', { name: 'Playback' }))
    expect(transport.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Previous frame', 'Play', 'Next frame', 'Pace 30 days/s'])
    const look = within(screen.getByRole('group', { name: 'Look' }))
    for (const name of ['Onion', 'Even light', 'Onion skin settings', 'Even light settings']) expect(look.getByRole('button', { name })).toBeInTheDocument()
  })

  // Critique round 5, P2-18: the strip stops at about 15 frames, within its stage.
  it('a wide player shows the full 15-frame strip', async () => {
    // Arrange
    stubLayout(1200, 800)

    // Act
    await openTimelapse()

    // Assert
    expect(strip().getAllByRole('option')).toHaveLength(15)
  })

  it('a 640 px column shows 13 frames', async () => {
    // Arrange: 690 px holds 15 frames at 3:4; 640 px holds 13.
    stubLayout(640, 900)

    // Act
    await openTimelapse()

    // Assert
    expect(strip().getAllByRole('option')).toHaveLength(13)
  })

  // P2-11: the transport and filmstrip centre on the frame, not on the column.
  it('gives the transport and filmstrip the frame’s axis', async () => {
    // Arrange: jsdom lays every element out at the same 1200 px box.
    stubLayout(1200, 800)

    // Act
    await openTimelapse()

    // Assert
    expect(player()).toHaveAttribute('data-axis', 'frame')
    expect((player() as HTMLElement).style.getPropertyValue('--frame-cx')).toBe('600px')
    expect((player() as HTMLElement).style.getPropertyValue('--col-w')).toBe('1200px')
  })

  it('the aligning strip fits the same way', async () => {
    // Arrange
    stubLayout(568, 640)
    const { backend } = await openTimelapse()
    backend.configure({ speed: 'fast' })

    // Act
    await act(async () => {
      await startAlign(session().render)
    })
    await screen.findByText(/^Aligning [\d,]+ of [\d,]+$/, { selector: '.row' })
    await waitFor(() => expect(useJobs.getState().align.recent.length).toBeGreaterThan(11))

    // Assert
    const finishing = within(screen.getByRole('listbox', { name: 'Frames as they finish' }))
    expect(finishing.getAllByRole('option').length).toBeLessThanOrEqual(11)
  })
})

// UI review 2, H3 (the reviewer's probe): two nudge fields committed inside one backend round trip.
describe('frame nudges racing their answers', () => {
  it('keeps both the across and the down nudge', async () => {
    // Arrange: each nudge answers after 80 ms.
    const { backend } = await openTimelapse()
    const handle = backend.handle
    Object.defineProperty(backend, 'handle', {
      value: async (cmd: string, payload?: unknown) => {
        if (cmd === 'set_frame_adjustment') await new Promise((resolve) => setTimeout(resolve, 80))
        return handle(cmd, payload)
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Toggle frame inspector' }))
    const photoId = frames()[0]?.photoId

    // Act
    const across = await screen.findByRole('textbox', { name: 'Move across, percent of the width' })
    fireEvent.change(across, { target: { value: '5' } })
    fireEvent.keyDown(across, { key: 'Enter' })
    const down = screen.getByRole('textbox', { name: 'Move down, percent of the height' })
    fireEvent.change(down, { target: { value: '3' } })
    fireEvent.keyDown(down, { key: 'Enter' })

    // Assert
    await waitFor(() => expect(frames().find((f) => f.photoId === photoId)?.adjust).toMatchObject({ dx: 0.05, dy: 0.03 }))
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)))
    expect(frames().find((f) => f.photoId === photoId)?.adjust).toMatchObject({ dx: 0.05, dy: 0.03 })
    expect(across).toHaveValue('5.0')
  })
})

// UI review 2, H4: the paused player kept an index past the end and spun forever.
describe('the player index follows the frames', () => {
  it('leaving the last day out moves the playhead onto the new last frame', async () => {
    // Arrange
    stubLayout(1200, 800)
    await openTimelapse()
    const n = frames().length
    await act(async () => usePlayer.getState().setIndex(n - 1))
    await waitFor(() => expect(screen.queryByLabelText('Loading frame')).toBeNull())

    // Act
    await act(async () => {
      await setDayExcluded(frames()[n - 1]?.dayKey ?? '', true)
    })

    // Assert
    await waitFor(() => expect(frames().length).toBe(n - 1))
    await waitFor(() => expect(usePlayer.getState().index).toBe(n - 2))
    await waitFor(() => expect(screen.queryByLabelText('Loading frame')).toBeNull())
  })

  // UI review 3, L2: a late session-changed (a slow restore) stopped playback and jumped to frame 1.
  // A library change leaves the playhead to the clamp; only Start over resets it.
  it('a library change keeps playing; Start over resets the player', async () => {
    await openTimelapse()
    act(() => {
      usePlayer.getState().setIndex(40)
      usePlayer.getState().toggle()
    })
    act(() => libraryReplaced())
    expect(usePlayer.getState()).toMatchObject({ index: 40, playing: true })
    await act(async () => {
      await resetSession()
    })
    expect(usePlayer.getState()).toMatchObject({ index: 0, settled: 0, playing: false })
  })
})

// UI review 2, M1: Space belongs to the focused control ("Enter and Space always belong to a focused button or option").
describe('Space on a focused Timelapse control', () => {
  it('presses the control instead of playing', async () => {
    await openTimelapse()
    const next = screen.getByRole('button', { name: 'Next frame' })
    next.focus()
    const notPrevented = fireEvent.keyDown(next, { key: ' ' })
    expect(notPrevented).toBe(true)
    expect(usePlayer.getState().playing).toBe(false)
    fireEvent.keyDown(document.body, { key: ' ' })
    expect(usePlayer.getState().playing).toBe(true)
    act(() => usePlayer.getState().pause())
  })
})

// UI review 2, L3: each N press toggled from the cached look, so two quick presses both turned it on.
describe('repeated presses build on what was asked for', () => {
  it('N twice before the first answer turns Even light on and then off again', async () => {
    // Arrange: every look change answers after 80 ms.
    const { backend } = await openTimelapse()
    const handle = backend.handle
    Object.defineProperty(backend, 'handle', {
      value: async (cmd: string, payload?: unknown) => {
        if (cmd === 'set_look') await new Promise((resolve) => setTimeout(resolve, 80))
        return handle(cmd, payload)
      },
    })
    expect(session().look.normalize).toBe('off')

    // Act
    fireEvent.keyDown(window, { key: 'n' })
    fireEvent.keyDown(window, { key: 'n' })

    // Assert
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(backend.current.look.normalize).toBe('off')
    expect(session().look.normalize).toBe('off')
  })
})

