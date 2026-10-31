// Critique round 4, signature moment 2 and P1-5: on Y the decided print takes
// a chinagraph tick and flies to its queue slot (on N a strike, in
// greyscale), the next print rises in, and the queue writes that photo's mark
// with the pen. Input never waits: a new decision ends the previous flight.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PhotoSummary } from '../../ipc/contract'
import { queryClient, queryKeys } from '../../state/queries'
import { stubLayout } from '../../test/layout'
import { renderApp } from '../../test/renderApp'

const mod = { metaKey: true, ctrlKey: true }
const unsure = () => queryClient.getQueryData<PhotoSummary[]>(queryKeys.photos(['uncertain'])) ?? []
const shownPrint = (id: string) => document.querySelector(`.candidate .print[data-key="${id}"]`)

interface Running {
  el: Element
  finish: () => void
  cancelled: boolean
}

/** WAAPI for the verdict (jsdom has none); each animation finishes when the test says so. */
function stubAnimations(): Running[] {
  const running: Running[] = []
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value(this: Element) {
      let finish: () => void = () => undefined
      const finished = new Promise<void>((resolve) => (finish = resolve))
      const entry: Running = { el: this, finish: () => finish(), cancelled: false }
      running.push(entry)
      return {
        finished,
        onfinish: null,
        cancel: () => {
          entry.cancelled = true
        },
      }
    },
  })
  return running
}

async function openReview() {
  stubLayout(1200, 800)
  await renderApp({ scenario: 'scanned' })
  fireEvent.keyDown(window, { key: '3', ...mod })
  // Review's code may still be on its way under a loaded test run: a generous wait, not a fixed delay.
  await screen.findByRole('button', { name: 'Keep' }, { timeout: 5000 })
  ;(document.activeElement as HTMLElement | null)?.blur()
}

afterEach(() => {
  delete window.__FT_MOCK__
  delete (Element.prototype as unknown as Record<string, unknown>).animate
})

describe('the verdict', () => {
  it('Y ticks the print and lifts it toward the film; N strikes the next one in greyscale and ends the first flight', async () => {
    // Arrange
    const running = stubAnimations()
    await openReview()
    const [first, second] = unsure() as [PhotoSummary, PhotoSummary]
    await waitFor(() => expect(shownPrint(first.id)).not.toBeNull())

    // Act: keep the first
    fireEvent.keyDown(document.body, { key: 'y' })

    // Assert: the decided print is the verdict, with a tick, and has left the frame
    const kept = document.querySelector('.verdict') as HTMLElement
    expect(kept).toHaveAttribute('data-review', 'confirmed')
    expect(kept.querySelector('.print')).toHaveAttribute('data-key', first.id)
    expect(kept.querySelector('.verdict-mark.tick svg.mark')).not.toBeNull()
    expect(shownPrint(first.id)).toBeNull()
    // …and the queue writes its tick with the pen.
    expect(document.querySelector(`.q-item[data-id="${first.id}"]`)).toHaveAttribute('data-just', 'true')
    await waitFor(() => expect(running.some((r) => r.el === kept)).toBe(true))

    // Act: leave the second out
    await waitFor(() => expect(shownPrint(second.id)).not.toBeNull())
    fireEvent.keyDown(document.body, { key: 'n' })

    // Assert: one verdict at a time; the first flight ended at once
    const verdicts = document.querySelectorAll('.verdict')
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toHaveAttribute('data-review', 'rejected')
    expect(verdicts[0]?.querySelector('.verdict-mark.strike svg.mark')).not.toBeNull()
    expect(running.filter((r) => r.el === kept).every((r) => r.cancelled)).toBe(true)

    // Act: the flight lands
    await waitFor(() => expect(running.some((r) => r.el === verdicts[0])).toBe(true))
    act(() => running.forEach((r) => r.finish()))

    // Assert
    await waitFor(() => expect(document.querySelector('.verdict')).toBeNull())
  })

  it('keeps up with a held Y: forty-one calls in a row, never more than one verdict in flight', async () => {
    // Arrange
    stubAnimations()
    await openReview()
    const n = unsure().length

    // Act
    for (let i = 0; i < n; i++) {
      fireEvent.keyDown(document.body, { key: 'y', repeat: i > 0 })
      expect(document.querySelectorAll('.verdict').length).toBeLessThanOrEqual(1)
    }

    // Assert
    expect(await screen.findByRole('heading', { name: `All ${n} looked at` })).toBeInTheDocument()
    expect(unsure().every((p) => p.review === 'confirmed')).toBe(true)
  })

  it('never lingers where the webview can’t animate it', async () => {
    await openReview()
    const first = unsure()[0] as PhotoSummary
    await waitFor(() => expect(shownPrint(first.id)).not.toBeNull())
    fireEvent.keyDown(document.body, { key: 'y' })
    await waitFor(() => expect(document.querySelector('.verdict')).toBeNull())
    expect(document.querySelector(`.q-item[data-id="${first.id}"]`)).toHaveAttribute('data-just', 'true')
  })

  it('undo forgets the verdict: no pen on the photo brought back', async () => {
    stubAnimations()
    await openReview()
    const first = unsure()[0] as PhotoSummary
    fireEvent.keyDown(document.body, { key: 'y' })
    fireEvent.keyDown(document.body, { key: 'u' })
    await waitFor(() => expect(unsure()[0]?.review).toBe('pending'))
    expect(document.querySelector('[data-just]')).toBeNull()
    expect(document.querySelector('.verdict')).toBeNull()
    await waitFor(() => expect(shownPrint(first.id)).not.toBeNull())
  })
})
