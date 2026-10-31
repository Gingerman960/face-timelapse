import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../test/renderApp'
import { setReferenceCrop } from '../state/actions'
import { queryClient, queryKeys } from '../state/queries'
import type { SessionSnapshot } from '../ipc/contract'
import { useView } from '../state/view'
import { usePlayer } from '../state/player'

const title = () => screen.getByRole('heading', { level: 1 })
const session = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session)
const mod = { metaKey: true, ctrlKey: true }

/** jsdom has no layout: give scrollers a size so virtualized grids render rows. */
function stubLayout(width = 1200, height = 800): void {
  const rect = { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height, toJSON: () => ({}) }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height)
}

describe('Reference (setup)', () => {
  it('first run: choose a photo and a folder, then the scan unlocks', async () => {
    await renderApp({ scenario: 'fresh' })
    expect(title()).toHaveTextContent('Reference')
    expect(screen.getByRole('heading', { name: 'Start with one photo of your face' })).toBeInTheDocument()
    // No plate before there is a reference (critique round 4): choosing the photo is the one action.
    expect(screen.queryByRole('button', { name: /^Scan library/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Choose photo/ }))
    expect(await screen.findByRole('group', { name: /^Crop/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Scan library/ })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /Choose folder/ }))
    expect(await screen.findByText('Still to read')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /^Scan library/ })).toBeEnabled())
  })

  it('changing the aspect commits a reshaped crop', async () => {
    await renderApp({ scenario: 'ready' })
    await userEvent.click(screen.getByRole('radio', { name: '1:1' }))
    await waitFor(() => expect(session()?.reference?.aspect).toBe('1:1'))
    const crop = session()?.reference?.crop
    expect(crop?.width).toBe(crop?.height)
  })

  it('arrow keys nudge the crop and commit after a short pause', async () => {
    await renderApp({ scenario: 'ready' })
    const x0 = session()?.reference?.crop.x ?? 0
    fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true })
    await waitFor(() => expect(session()?.reference?.crop.x).toBe(x0 - 10), { timeout: 2000 })
  })

  it('a crop without a face is an inline state, not a banner', async () => {
    await renderApp({ scenario: 'ready' })
    await act(async () => {
      await setReferenceCrop({ x: 0, y: 0, width: 600, height: 800 }, '3:4')
    })
    expect(await screen.findByText(/No face found inside the crop/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Scan library/ })).toBeDisabled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('Scan', () => {
  it('a finished scan with unsure photos opens Review', async () => {
    await renderApp({ scenario: 'ready' })
    await userEvent.click(screen.getByRole('button', { name: /^Scan library/ }))
    await waitFor(() => expect(title()).toHaveTextContent('Review'), { timeout: 5000 })
    expect(session()?.scan.status).toBe('complete')
  })

  it('the library view after a scan can rescue a photo', async () => {
    stubLayout()
    await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '2', ...mod })
    expect(await screen.findByRole('heading', { name: /Found you in/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'Not you' }))
    const sheet = await screen.findByLabelText('Photos in the library')
    const first = await within(sheet).findAllByRole('button')
    await userEvent.click(first[0] as HTMLElement)
    const before = session()?.counts.included ?? 0
    await userEvent.click(screen.getByRole('button', { name: /Use this photo/ }))
    await waitFor(() => expect(session()?.counts.included).toBe(before + 1))
  })
})

describe('Review', () => {
  it('Y keeps, N leaves out, U undoes, ⇧A keeps the rest', async () => {
    await renderApp({ scenario: 'scanned' })
    fireEvent.keyDown(window, { key: '3', ...mod })
    // Review's code may still be on its way under a loaded test run: a generous wait, not a fixed delay.
    await screen.findByRole('button', { name: 'Keep' }, { timeout: 5000 })
    const pending0 = session()?.counts.reviewPending ?? 0
    fireEvent.keyDown(window, { key: 'y' })
    fireEvent.keyDown(window, { key: 'n' })
    await waitFor(() => expect(session()?.counts.reviewPending).toBe(pending0 - 2))
    fireEvent.keyDown(window, { key: 'u' })
    await waitFor(() => expect(session()?.counts.reviewPending).toBe(pending0 - 1))
    fireEvent.keyDown(window, { key: 'A', shiftKey: true })
    expect(await screen.findByRole('heading', { name: /All .* looked at/ })).toBeInTheDocument()
    // The done state waits for Continue (QA batch 3: no auto-advance).
    expect(title()).toHaveTextContent('Review')
    await userEvent.click(screen.getByRole('button', { name: /^Continue to Days/ }))
    await waitFor(() => expect(title()).toHaveTextContent('Days'))
  })

  it('holding Space compares with the reference', async () => {
    await renderApp({ scenario: 'scanned' })
    fireEvent.keyDown(window, { key: '3', ...mod })
    const compare = await screen.findByRole('button', { name: /Compare/ }, { timeout: 5000 })
    fireEvent.keyDown(window, { key: ' ' })
    expect(compare).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyUp(window, { key: ' ' })
    expect(compare).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('Days', () => {
  it('selects days, picks alternates, leaves a day out and moves a photo', async () => {
    await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '4', ...mod })
    await screen.findByRole('complementary', { name: 'Selected day' })
    await act(async () => useView.getState().setActiveDay('2014-05-02'))
    expect(await screen.findByRole('heading', { name: '2 May 2014' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: '2' })
    await waitFor(() => expect(screen.getByText(/your pick/)).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'x' })
    await waitFor(() => expect(screen.getByRole('button', { name: /Put this day back in/ })).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'x' })
    fireEvent.keyDown(window, { key: 'm' })
    expect(await screen.findByText(/Moving the photo from/)).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(await screen.findByText(/^Moved to /)).toBeInTheDocument()
  })

  it('arrows walk days and the zoom changes views', async () => {
    await renderApp({ scenario: 'aligned' })
    fireEvent.keyDown(window, { key: '4', ...mod })
    await screen.findByRole('complementary', { name: 'Selected day' })
    await act(async () => useView.getState().setActiveDay('2014-05-02'))
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(await screen.findByRole('heading', { name: '3 May 2014' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'Decade' }))
    expect(await screen.findByRole('button', { name: /^2014, / })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'Month' }))
    expect(await screen.findByRole('region', { name: 'May 2014' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Add a photo to this day/ }))
  })
})

describe('Timelapse and export', () => {
  it('plays, steps, shows onion skin and the sheet view', async () => {
    await renderApp({ scenario: 'aligned' })
    expect(title()).toHaveTextContent('Timelapse')
    await screen.findByRole('toolbar', { name: 'Playback' })
    fireEvent.keyDown(window, { key: ' ' })
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: ' ' })
    await act(async () => usePlayer.getState().setIndex(0))
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(usePlayer.getState().index).toBe(1)
    fireEvent.keyDown(window, { key: 'l' })
    expect(usePlayer.getState()).toMatchObject({ playing: true, rate: 1 })
    fireEvent.keyDown(window, { key: 'k' })
    fireEvent.keyDown(window, { key: 'o' })
    expect(await screen.findByText(/Onion skin: previous day/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'Sheet' }))
    expect(await screen.findByLabelText('All aligned frames')).toBeInTheDocument()
  })

  it('even light changes the look', async () => {
    await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    fireEvent.keyDown(window, { key: 'n' })
    await waitFor(() => expect(session()?.look.normalize).not.toBe('off'))
  })

  it('export couples the pace (days a second) and the length like the legacy dialog and saves a video', async () => {
    await renderApp({ scenario: 'aligned' })
    await screen.findByRole('toolbar', { name: 'Playback' })
    fireEvent.keyDown(window, { key: 'e' })
    const sheet = await screen.findByRole('dialog', { name: 'Export timelapse' })
    // The aligned scenario cuts between days, so 10 days a second is 10 frames a second.
    const pace = within(sheet).getByLabelText('Days a second')
    await userEvent.clear(pace)
    await userEvent.type(pace, '10{Enter}')
    const frames = session()?.frames.count ?? 0
    const expected = (frames / 10 + (session()?.video.holdLastSecs ?? 0)).toFixed(1)
    await waitFor(() => expect(within(sheet).getByLabelText('Duration')).toHaveValue(`${Math.floor(Number(expected) / 60)}:${(Number(expected) % 60).toFixed(1).padStart(4, '0')}`))
    await userEvent.click(within(sheet).getByRole('button', { name: /^Export…/ }))
    expect(await within(sheet).findByRole('heading', { name: 'Saved' })).toBeInTheDocument()
  })
})

const REFERENCE_PATH = '/Users/demo/Pictures/Reference/IMG_20140815_142326.jpg'

describe('Drag and drop', () => {
  it('shows the overlay and uses a dropped photo as the reference', async () => {
    const { backend } = await renderApp({ scenario: 'fresh' })
    void backend
    const mock = (window as unknown as { __FT_MOCK__: { emitDragEnter: (p: string[]) => Promise<void> | void; emitDragDrop: (p: string[]) => Promise<void> | void } }).__FT_MOCK__
    await act(async () => {
      await mock.emitDragEnter([REFERENCE_PATH])
    })
    expect(await screen.findByText('Release to use as reference')).toBeInTheDocument()
    await act(async () => {
      await mock.emitDragDrop([REFERENCE_PATH])
    })
    expect(await screen.findByRole('group', { name: /^Crop/ })).toBeInTheDocument()
  })
})
