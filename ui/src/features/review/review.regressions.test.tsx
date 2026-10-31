// Regressions from UI review #1: H5 (Enter/Space on a focused control),
// M17 (virtualized queue), L5 (undo while busy).
import { afterEach, describe, expect, it } from 'vitest'
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PhotoSummary } from '../../ipc/contract'
import { renderApp } from '../../test/renderApp'
import { DEFAULT_MESSAGES } from '../../ipc/mock/errors'
import { stubLayout } from '../../test/layout'
import { queryClient, queryKeys } from '../../state/queries'
import { useJobs } from '../../state/jobs'
import { useView } from '../../state/view'

const mod = { metaKey: true, ctrlKey: true }
const unsure = () => queryClient.getQueryData<PhotoSummary[]>(queryKeys.photos(['uncertain'])) ?? []

async function openReview() {
  const r = await renderApp({ scenario: 'scanned' })
  fireEvent.keyDown(window, { key: '3', ...mod })
  // Review's code may still be on its way under a loaded test run: a generous wait, not a fixed delay.
  await screen.findByRole('button', { name: 'Keep' }, { timeout: 5000 })
  return r
}

afterEach(() => {
  delete window.__FT_MOCK__
})

describe('H5: Enter and Space belong to the focused control', () => {
  it('Enter on a focused “Leave out” leaves the photo out (it does not keep it)', async () => {
    await openReview()
    const first = unsure()[0] as PhotoSummary
    screen.getByRole('button', { name: 'Leave out' }).focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(unsure().find((p) => p.id === first.id)?.review).toBe('rejected'))
  })

  it('Enter on “Skip to Days” continues without deciding the current photo', async () => {
    await openReview()
    const first = unsure()[0] as PhotoSummary
    screen.getByRole('button', { name: /^Skip to Days/ }).focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(useView.getState().step).toBe('days'))
    expect(unsure().find((p) => p.id === first.id)?.review).toBe('pending')
  })

  it('Space on a focused queue photo selects it rather than starting a compare', async () => {
    stubLayout(1200, 800)
    await openReview()
    const options = within(screen.getByRole('listbox', { name: 'Unsure photos' })).getAllByRole('option')
    const third = options[2] as HTMLElement
    third.focus()
    await userEvent.keyboard(' ')
    expect(screen.getByRole('button', { name: 'Compare' })).toHaveAttribute('aria-pressed', 'false')
    expect(useView.getState().reviewIndex).toBe(2)
  })

  it('with nothing focused, Enter still keeps (the shortcut)', async () => {
    await openReview()
    const first = unsure()[0] as PhotoSummary
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    await waitFor(() => expect(unsure().find((p) => p.id === first.id)?.review).toBe('confirmed'))
  })
})

describe('M17: the queue is virtualized', () => {
  it('renders only the photos near the view, with set size and position for each', async () => {
    stubLayout(400, 80)
    await openReview()
    const list = screen.getByRole('listbox', { name: 'Unsure photos' })
    const options = within(list).getAllByRole('option')
    expect(options.length).toBeLessThan(unsure().length)
    expect(options[0]).toHaveAttribute('aria-setsize', String(unsure().length))
    expect(options[0]).toHaveAttribute('aria-posinset', '1')
  })
})

describe('L5: undo while a job runs keeps the undo entry', () => {
  it('does not pop the entry when the decision can’t be sent', async () => {
    await openReview()
    fireEvent.keyDown(window, { key: 'y' })
    expect(useView.getState().reviewUndo).toHaveLength(1)
    act(() => useJobs.setState({ activeJobId: 'job-x', activeKind: 'exportVideo' }))
    fireEvent.keyDown(window, { key: 'u' })
    expect(useView.getState().reviewUndo).toHaveLength(1)
    act(() => useJobs.setState({ activeJobId: null, activeKind: null }))
  })
})

// QA batch 3: the done state used to hand over to Days after 600 ms, before it could be read.
describe('Review done waits for Continue', () => {
  it('stays on the done state after the last call until Continue to Days', async () => {
    // Arrange
    await openReview()

    // Act
    await userEvent.click(screen.getByRole('button', { name: /^Keep all remaining/ }))
    expect(await screen.findByRole('heading', { name: 'All 41 looked at' })).toBeInTheDocument()
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 900)))

    // Assert
    expect(useView.getState().step).toBe('review')
    await userEvent.click(screen.getByRole('button', { name: /^Continue to Days/ }))
    expect(useView.getState().step).toBe('days')
  })
})

// Critique round 3: Keep, Leave out, Compare are weighted primary, secondary,
// tertiary; while photos are pending the way on is a quiet "Skip to Days" that
// names its cost, and ⌘↩ rests, so it can't quietly leave photos out.
describe('Review decision hierarchy', () => {
  it('while photos are pending, the toolbar offers Skip to Days with the count that stays out, and no plate', async () => {
    // Arrange
    await openReview()
    const pending = unsure().filter((p) => p.review === 'pending').length

    // Assert
    const toolbar = document.querySelector('.toolbar') as HTMLElement
    expect(within(toolbar).getByRole('button', { name: /^Skip to Days/ })).toHaveTextContent(`Skip to Days · ${pending} stay out`)
    expect(within(toolbar).queryByRole('button', { name: /^Continue to Days/ })).toBeNull()
    expect(toolbar.querySelector('.btn-plate')).toBeNull()
    const decide = screen.getByRole('group', { name: 'Decide' })
    expect(within(decide).getByRole('button', { name: 'Keep' })).toHaveClass('keep')
    expect(within(decide).getAllByRole('button').map((b) => b.querySelector('kbd')?.textContent)).toEqual(['N', 'Space', 'Y'])
  })

  it('a click on Keep keeps the current photo and moves on', async () => {
    // Arrange
    await openReview()
    const first = unsure()[0] as PhotoSummary

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))

    // Assert
    await waitFor(() => expect(unsure().find((p) => p.id === first.id)?.review).toBe('confirmed'))
    expect(useView.getState().reviewIndex).toBe(1)
  })

  it('⌘↩ rests while photos are pending and continues once all are looked at', async () => {
    // Arrange
    await openReview()
    const first = unsure()[0] as PhotoSummary

    // Act: ⌘↩ with photos pending
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert: nothing moved and nothing was decided
    expect(useView.getState().step).toBe('review')
    expect(unsure().find((p) => p.id === first.id)?.review).toBe('pending')

    // Act: settle the rest, then ⌘↩
    await userEvent.click(screen.getByRole('button', { name: /^Keep all remaining/ }))
    await screen.findByRole('heading', { name: 'All 41 looked at' })
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert
    expect(useView.getState().step).toBe('days')
  })
})

// UI review 4, L2: the done state unmounted the focused control and focus fell to <body>.
describe('focus when Review is done', () => {
  it('moves to Continue to Days when the last call is made, and a held Enter can’t press it', async () => {
    // Arrange
    await openReview()
    const keepAll = screen.getByRole('button', { name: /^Keep all remaining/ })
    keepAll.focus()

    // Act
    await userEvent.click(keepAll)

    // Assert
    await screen.findByRole('heading', { name: 'All 41 looked at' })
    const plate = screen.getByRole('button', { name: /^Continue to Days/ })
    await waitFor(() => expect(document.activeElement).toBe(plate))
    const held = createEvent.keyDown(plate, { key: 'Enter', repeat: true })
    fireEvent(plate, held)
    expect(held.defaultPrevented).toBe(true)
    expect(useView.getState().step).toBe('review')
  })

  it('leaves focus alone when Review opens already done', async () => {
    // Arrange
    await openReview()
    await userEvent.click(screen.getByRole('button', { name: /^Keep all remaining/ }))
    await screen.findByRole('heading', { name: 'All 41 looked at' })
    fireEvent.keyDown(window, { key: '4', ...mod })
    await waitFor(() => expect(useView.getState().step).toBe('days'))
    ;(document.activeElement as HTMLElement | null)?.blur()

    // Act
    fireEvent.keyDown(window, { key: '3', ...mod })

    // Assert: no control takes focus; the screen change puts it on the screen's region (critique round 5, P1-4).
    await screen.findByRole('heading', { name: 'All 41 looked at' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Review' })))
  })
})

// UI review 4, L3: a failed batch left its undo entry, so the next U undid a call that never happened.
describe('a failed decision batch', () => {
  it('rolls the photo back and drops its undo entry', async () => {
    // Arrange
    const { backend } = await openReview()
    const first = unsure()[0] as PhotoSummary
    backend.configure({ fail: { set_review_decision: 'io' } })

    // Act
    fireEvent.keyDown(window, { key: 'y' })
    expect(useView.getState().reviewUndo).toHaveLength(1)

    // Assert: the batch fails, the photo is pending again, and there is nothing to undo.
    expect(await screen.findByText(DEFAULT_MESSAGES.io)).toBeInTheDocument()
    await waitFor(() => expect(unsure().find((p) => p.id === first.id)?.review).toBe('pending'))
    expect(useView.getState().reviewUndo).toHaveLength(0)
  })
})

// UI review 2, M2: arrows on a focused queue photo decided the current photo.
describe('the queue is a listbox the arrows browse', () => {
  it('→, ← and End move between queue photos without deciding anything', async () => {
    // Arrange
    stubLayout(1200, 800)
    await openReview()
    const first = unsure()[0] as PhotoSummary
    const options = () => within(screen.getByRole('listbox', { name: 'Unsure photos' })).getAllByRole('option')
    const start = options()[0] as HTMLElement
    start.focus()

    // Act + Assert
    fireEvent.keyDown(start, { key: 'ArrowRight' })
    await waitFor(() => expect(useView.getState().reviewIndex).toBe(1))
    await waitFor(() => expect(document.activeElement).toHaveAttribute('aria-posinset', '2'))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    await waitFor(() => expect(useView.getState().reviewIndex).toBe(0))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Backspace' })
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    await waitFor(() => expect(useView.getState().reviewIndex).toBe(unsure().length - 1))
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)))
    expect(unsure().find((p) => p.id === first.id)?.review).toBe('pending')
    expect(unsure().every((p) => p.review === 'pending')).toBe(true)
  })
})

// UI review 2, L5: Space on the focused Compare button: the window keyup turned compare off
// before the button's own keyup activation toggled it, so it went straight back on.
describe('Space on the Compare button', () => {
  it('leaves Compare to the button: the window keyup does not touch it', async () => {
    await openReview()
    const compare = screen.getByRole('button', { name: /Compare/ })
    fireEvent.click(compare)
    expect(compare).toHaveAttribute('aria-pressed', 'true')
    compare.focus()
    fireEvent.keyDown(compare, { key: ' ' })
    fireEvent.keyUp(compare, { key: ' ' })
    expect(compare).toHaveAttribute('aria-pressed', 'true')
  })

  it('a held Space elsewhere still compares while held', async () => {
    await openReview()
    const compare = screen.getByRole('button', { name: /Compare/ })
    fireEvent.keyDown(document.body, { key: ' ' })
    expect(compare).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyUp(document.body, { key: ' ' })
    expect(compare).toHaveAttribute('aria-pressed', 'false')
  })
})

// UI review 3, M4: on "All N looked at" the decision keys still re-decided the photo under the cursor.
describe('the done state takes no decision keys', () => {
  it('Enter, →, Y, N and ⌫ change nothing once every photo is decided; U still undoes', async () => {
    // Arrange: leave every photo out with N.
    await openReview()
    const n = unsure().length
    ;(document.activeElement as HTMLElement | null)?.blur()
    for (let i = 0; i < n; i++) fireEvent.keyDown(document.body, { key: 'n' })
    await screen.findByRole('heading', { name: `All ${n} looked at` })
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))
    expect(unsure().every((p) => p.review === 'rejected')).toBe(true)

    // Act
    for (const key of ['Enter', 'ArrowRight', 'y', 'ArrowLeft', 'Backspace']) fireEvent.keyDown(document.body, { key })
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))

    // Assert
    expect(unsure().every((p) => p.review === 'rejected')).toBe(true)
    fireEvent.keyDown(document.body, { key: 'u' })
    await waitFor(() => expect(unsure().filter((p) => p.review === 'pending')).toHaveLength(1))
  })
})

// UI review 3, L1: an arrow at the queue's edge left a pending focus target that pulled focus back later.
describe('the queue never pulls focus back', () => {
  it('after ← on the first photo, focus moved elsewhere stays there through re-renders', async () => {
    stubLayout(1200, 800)
    await openReview()
    const first = within(screen.getByRole('listbox', { name: 'Unsure photos' })).getAllByRole('option')[0] as HTMLElement
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    const keepAll = screen.getByRole('button', { name: /^Keep all remaining/ })
    keepAll.focus()
    act(() => useJobs.setState({ activeJobId: 'job-x', activeKind: 'exportVideo' }))
    act(() => useJobs.setState({ activeJobId: null, activeKind: null }))
    expect(document.activeElement).toBe(keepAll)
  })
})

describe('queue keys back onto the current photo', () => {
  it('← from the photo after the current one moves focus there without picking again', async () => {
    stubLayout(1200, 800)
    await openReview()
    const options = within(screen.getByRole('listbox', { name: 'Unsure photos' })).getAllByRole('option')
    const second = options[1] as HTMLElement
    second.focus()
    fireEvent.keyDown(second, { key: 'ArrowLeft' })
    expect(document.activeElement).toHaveAttribute('aria-posinset', '1')
    expect(useView.getState().reviewIndex).toBe(0)
  })
})

describe('queueTarget', () => {
  it('maps the listbox keys and leaves the rest alone', async () => {
    const { queueTarget } = await import('./ReviewQueue')
    expect(queueTarget('ArrowLeft', 0, 5)).toBe(0)
    expect(queueTarget('ArrowRight', 4, 5)).toBe(4)
    expect(queueTarget('Home', 3, 5)).toBe(0)
    expect(queueTarget('End', 1, 5)).toBe(4)
    expect(queueTarget('Backspace', 2, 5)).toBe(2)
    expect(queueTarget('y', 2, 5)).toBeNull()
  })
})
