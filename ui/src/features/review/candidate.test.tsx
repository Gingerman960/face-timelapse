// Critique round 4, P1-4: a decision used to show the unaligned cover-fit
// photo first, then swap to the aligned one. Now the outgoing print is held
// until the next one is decoded and aligned, then they cross-fade; a print
// that was just decided leaves at once (it flies off as the verdict) and the
// next rises from the well. Outside the aligned photo, a blurred copy fills.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PhotoDetail, PhotoSummary } from '../../ipc/contract'
import { samples } from '../../ipc/contract.samples'
import { stubLayout } from '../../test/layout'
import { Candidate, type ShownPrint } from './Candidate'
import { keepPrints } from './printCache'

const A: PhotoSummary = { ...samples.PhotoSummary, id: 'aaaaaaaaaaaaaaaa', status: 'uncertain' }
const B: PhotoSummary = { ...A, id: 'bbbbbbbbbbbbbbbb', version: 'bbbb' }
/** A detail without a preview (no reference face yet): the client-side alignment and fill. */
const detailOf = (photo: PhotoSummary): PhotoDetail => ({ ...samples.PhotoDetail, summary: photo, previewVersion: null })
/** A detail with the v1.7 preview route: the backend's own aligned frame. */
const withPreview = (photo: PhotoSummary, version = 'cafe0001'): PhotoDetail => ({ ...samples.PhotoDetail, summary: photo, previewVersion: version })

function candidate(props: Partial<ComponentProps<typeof Candidate>> = {}) {
  return (
    <Candidate
      photo={A}
      detail={detailOf(A)}
      detailPending={false}
      refAnchors={samples.ReferenceDetection.anchors}
      base="ftimg://localhost/"
      referenceFrameUrl={null}
      compare={false}
      alt="Unsure match"
      {...props}
    />
  )
}

const prints = () => [...document.querySelectorAll<HTMLElement>('.print')]
const keys = () => prints().map((el) => el.dataset.key)
const top = () => prints().at(-1) as HTMLElement

beforeEach(() => {
  stubLayout(300, 400)
})
afterEach(() => {
  keepPrints([])
})

describe('the candidate print', () => {
  it('waits for the detail and shows the print aligned, never the unaligned photo first', async () => {
    // Arrange
    const { rerender } = render(candidate({ detail: undefined, detailPending: true }))

    // Assert: nothing yet, and no cover-fit fallback
    expect(prints()).toHaveLength(0)
    expect(document.querySelector('.cand-fallback')).toBeNull()

    // Act
    rerender(candidate())

    // Assert
    await waitFor(() => expect(keys()).toEqual([A.id]))
    expect((document.querySelector('.cand-img') as HTMLElement).style.transform).toMatch(/^matrix\(/)
    expect(document.querySelector('.cand-fallback')).toBeNull()
    expect(screen.getByAltText('Unsure match')).toBe(document.querySelector('.cand-img'))
  })

  it('holds the outgoing print while the next detail is coming, then cross-fades', async () => {
    // Arrange
    const { rerender } = render(candidate())
    await waitFor(() => expect(keys()).toEqual([A.id]))

    // Act: B's detail is still on its way
    rerender(candidate({ photo: B, detail: undefined, detailPending: true }))

    // Assert: A stays (marked held), no fallback, and it no longer claims to be the current photo
    expect(keys()).toEqual([A.id])
    expect(top()).toHaveClass('held')
    expect(document.querySelector('.cand-fallback')).toBeNull()
    expect(screen.queryByAltText('Unsure match')).toBeNull()

    // Act: B's detail arrives
    rerender(candidate({ photo: B, detail: detailOf(B) }))

    // Assert: B fades in over A, then A goes
    await waitFor(() => expect(keys()).toEqual([A.id, B.id]))
    expect(top()).toHaveClass('xfade')
    fireEvent.animationEnd(top())
    expect(keys()).toEqual([B.id])
  })

  it('lets a just-decided print go at once and raises the next one from the well', async () => {
    // Arrange
    const { rerender } = render(candidate())
    await waitFor(() => expect(keys()).toEqual([A.id]))

    // Act: A was decided; B is current
    rerender(candidate({ photo: B, detail: detailOf(B), justDecided: A.id }))

    // Assert: A is gone at once, B rises alone
    expect(keys()).not.toContain(A.id)
    await waitFor(() => expect(keys()).toEqual([B.id]))
    expect(top()).toHaveClass('rise')
  })

  it('shows the photo cover-fit when there is nothing to align it by', async () => {
    render(candidate({ detail: undefined, detailPending: false }))
    await waitFor(() => expect(document.querySelector('.cand-fallback')).not.toBeNull())
    expect(document.querySelector('.cand-img')).toBeNull()
    expect(document.querySelector('.print-fill')).toBeNull()
  })

  it('fills outside the aligned photo with a blurred copy of it', async () => {
    render(candidate())
    await waitFor(() => expect(document.querySelector('.print-fill img')).not.toBeNull())
    const fill = document.querySelector('.print-fill img') as HTMLImageElement
    const sharp = document.querySelector('.cand-img') as HTMLImageElement
    expect(fill.getAttribute('src')).toBe(sharp.getAttribute('src'))
    expect(fill.style.transform).toMatch(/^matrix\(/)
    expect(fill.style.transform).not.toBe(sharp.style.transform)
    expect(fill.getAttribute('alt')).toBe('')
  })

  it('hands the print on show to the verdict, and nothing while it holds another photo', async () => {
    // Arrange
    const shown: { current: ShownPrint | null } = { current: null }
    const onShown = (s: ShownPrint | null) => {
      shown.current = s
    }
    const { rerender } = render(candidate({ onShown }))

    // Assert
    await waitFor(() => expect(shown.current?.spec.key).toBe(A.id))
    expect(shown.current?.frame).toBe(document.querySelector('.candidate-frame'))

    // Act: holding A for B
    rerender(candidate({ photo: B, detail: undefined, detailPending: true, onShown }))

    // Assert
    expect(shown.current).toBeNull()
  })
})

// Contract v1.7: the preview route renders the frame the photo would get now (extended edges and
// all), so Review shows exactly that; the client-side matrix and fill are only a fallback.
describe('the candidate print from the preview route', () => {
  it('shows the backend’s aligned preview, cover-fit, with no matrix and no fill', async () => {
    render(candidate({ detail: withPreview(A) }))
    await waitFor(() => expect(keys()).toEqual([A.id]))
    const img = document.querySelector('.cand-preview') as HTMLImageElement
    expect(img.getAttribute('src')).toMatch(new RegExp(`^ftimg://localhost/preview/${A.id}\\?w=(640|1280)&v=cafe0001$`))
    expect(img).toHaveAttribute('alt', 'Unsure match')
    expect(document.querySelector('.cand-img')).toBeNull()
    expect(document.querySelector('.print-fill')).toBeNull()
  })

  it('a preview that keeps failing (404) quietly falls back to the client-side alignment', async () => {
    // Arrange: every decode of the preview fails; the thumbnail decodes.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (this: HTMLImageElement) {
      return this.src.includes('/preview/') ? Promise.reject(new Error('404')) : Promise.resolve()
    })
    try {
      // Act
      render(candidate({ detail: withPreview(A) }))
      await vi.advanceTimersByTimeAsync(3000)

      // Assert
      await waitFor(() => expect(document.querySelector('.cand-img')).not.toBeNull())
      expect((document.querySelector('.cand-img') as HTMLElement).style.transform).toMatch(/^matrix\(/)
      expect(document.querySelector('.cand-preview')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

