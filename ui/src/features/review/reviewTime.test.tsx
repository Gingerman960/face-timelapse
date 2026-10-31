// Contract v1.4 (QA LOW): Review shows a photo's time only when it is known,
// so a date-only file name never reads "00:00".
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { PhotoSummary } from '../../ipc/contract'
import { samples } from '../../ipc/contract.samples'
import { ReviewStage } from './ReviewParts'

/** Renders the comparison for `photo` and returns its "when" caption. */
function when(photo: PhotoSummary): HTMLElement {
  render(
    <ReviewStage
      referenceDay="2014-08-15"
      photo={photo}
      detail={undefined}
      refAnchors={null}
      base=""
      referenceFrameUrl={null}
      compare={false}
      busy={false}
      onDecide={() => undefined}
      onToggleCompare={() => undefined}
    />,
  )
  return document.querySelector('.candidate .when') as HTMLElement
}

describe('Review captions: date and time of day', () => {
  // Critique round 2: one counter (the queue's), and the reference captioned by its date like the candidate.
  it('captions the reference by its date and keeps the counter out of the prints', () => {
    when(samples.PhotoSummary)
    const [ref, cand] = [...document.querySelectorAll('.pair figcaption')]
    expect(ref).toHaveTextContent(/^ReferenceFri 15 Aug 2014$/)
    expect(cand).toHaveTextContent(/^Unsure matchFri 15 Aug 2014 · 14:23$/)
  })

  it('shows the time of a photo whose time is known', () => {
    expect(when(samples.PhotoSummary)).toHaveTextContent(/^Fri 15 Aug 2014 · 14:23$/)
  })

  it('shows only the date for a date-only file name, never 00:00', () => {
    const dateOnly = { ...samples.PhotoSummary, ...samples.PhotoSummary_noFace, status: 'uncertain' } satisfies PhotoSummary
    const caption = when(dateOnly)
    expect(caption).toHaveTextContent(/^Sat 27 Aug 2022$/)
    expect(caption.textContent).not.toContain('00:00')
  })

  it('shows only the date for a photo moved by hand', () => {
    expect(when({ ...samples.PhotoSummary, dateSource: 'manual', dayKey: '2014-08-14' })).toHaveTextContent(/^Thu 14 Aug 2014$/)
  })
})
