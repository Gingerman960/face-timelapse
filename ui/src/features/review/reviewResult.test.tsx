// Critique round 4: Review done is the result (P2-14), Review with nothing to
// review reuses it (P2-20), and the faces fact reads in words (item 19).
import { afterEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { PhotoDetail, PhotoSummary } from '../../ipc/contract'
import { samples } from '../../ipc/contract.samples'
import { queryClient, queryKeys } from '../../state/queries'
import { stubLayout } from '../../test/layout'
import { renderApp } from '../../test/renderApp'
import { ReviewFacts } from './ReviewParts'
import { filmWidth } from './ReviewQueue'

const mod = { metaKey: true, ctrlKey: true }
const unsureKey = queryKeys.photos(['uncertain'])

async function reviewWith(keep: (all: PhotoSummary[]) => PhotoSummary[]) {
  stubLayout(1200, 800)
  await renderApp({ scenario: 'scanned' })
  fireEvent.keyDown(window, { key: '3', ...mod })
  // Review's code may still be on its way under a loaded test run: a generous wait, not a fixed delay.
  await screen.findByRole('button', { name: 'Keep' }, { timeout: 5000 })
  act(() => {
    queryClient.setQueryData(unsureKey, keep(queryClient.getQueryData<PhotoSummary[]>(unsureKey) ?? []))
  })
}

afterEach(() => {
  delete window.__FT_MOCK__
})

describe('Review done is the result', () => {
  it('a centred strip of 72 px frames with the counts above it, the last call written with the pen', async () => {
    // Arrange
    await reviewWith((all) => all.slice(0, 3))
    ;(document.activeElement as HTMLElement | null)?.blur()

    // Act: keep, leave out, keep
    for (const key of ['y', 'n', 'y']) fireEvent.keyDown(document.body, { key })

    // Assert
    expect(await screen.findByRole('heading', { name: 'All 3 looked at' })).toBeInTheDocument()
    const summary = document.querySelector('.done-summary') as HTMLElement
    expect(summary).toHaveTextContent('2 kept, 1 left out. You can change any of them later from Days or the library.')
    expect([...summary.querySelectorAll('.digits')].map((d) => d.textContent)).toEqual(['2', '1'])
    const strip = screen.getByRole('list', { name: 'Reviewed photos' })
    expect(strip.style.getPropertyValue('--cell')).toBe('72px')
    expect(strip.style.getPropertyValue('--film-w')).toBe(`${filmWidth(3, false, 72)}px`)
    expect(within(strip).getAllByRole('listitem').map((li) => li.getAttribute('aria-label')?.split(',')[0])).toEqual(['Kept', 'Left out', 'Kept'])
    expect(strip.querySelectorAll('[data-just]')).toHaveLength(1)
    expect(within(strip).getAllByRole('listitem')[2]).toHaveAttribute('data-just', 'true')
    // The strip is the result: no separate big tick over it.
    expect(document.querySelector('.review-done svg.mark.big')).toBeNull()
  })
})

describe('Review with nothing to review', () => {
  it('reuses the done composition: "Nothing needed your eye" and the way on', async () => {
    // Act
    await reviewWith(() => [])

    // Assert
    expect(await screen.findByRole('heading', { name: 'Nothing needed your eye' })).toBeInTheDocument()
    expect(screen.getByText('The scan was sure about every photo it read.')).toBeInTheDocument()
    expect(screen.getByText('No photos the scan wasn’t sure about')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Continue to Days/ })).toHaveLength(1)
    expect(screen.queryByRole('list', { name: 'Reviewed photos' })).toBeNull()
  })
})

describe('the faces fact', () => {
  const photo = { ...samples.PhotoSummary, status: 'uncertain' } satisfies PhotoSummary
  const face = samples.FaceGeometry
  const faces = (detail: PhotoDetail | undefined) => {
    render(<ReviewFacts photo={photo} detail={detail} />)
    return screen.getByText('Faces').nextElementSibling as HTMLElement
  }

  it('reads "One face" for a photo with one face', () => {
    expect(faces({ ...samples.PhotoDetail, faces: [face] })).toHaveTextContent(/^One face$/)
  })

  it('reads "2 faces · best match used", the count in the data font', () => {
    const dd = faces({ ...samples.PhotoDetail, faces: [face, face] })
    expect(dd).toHaveTextContent(/^2 faces · best match used$/)
    expect([...dd.querySelectorAll('.digits')].map((d) => d.textContent)).toEqual(['2'])
  })

  it('waits with an ellipsis until the detail is known', () => {
    expect(faces(undefined)).toHaveTextContent(/^…$/)
  })
})
