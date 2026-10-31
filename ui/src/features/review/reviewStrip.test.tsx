// Critique round 4, P2-14 and P1-5: a strip is as long as its film (it ends
// 3 px after its last frame, and a short one is centred), and the mark of the
// photo just decided is written with the pen while every other mark just sits.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { PhotoSummary, ReviewDecision } from '../../ipc/contract'
import { samples } from '../../ipc/contract.samples'
import { stubLayout } from '../../test/layout'
import { filmWidth, ReviewQueue } from './ReviewQueue'

function photo(n: number, review: ReviewDecision = 'pending'): PhotoSummary {
  return { ...samples.PhotoSummary, id: String(n).padStart(16, '0'), status: 'uncertain', review }
}

/** Gives SVG paths geometry and elements WAAPI, so the pen runs; returns the elements it animated. */
function stubPen(): Element[] {
  const animated: Element[] = []
  Object.defineProperty(SVGElement.prototype, 'getTotalLength', { configurable: true, value: () => 100 })
  Object.defineProperty(SVGElement.prototype, 'getPointAtLength', { configurable: true, value: () => ({ x: 0, y: 0 }) })
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value(this: Element) {
      animated.push(this)
      return { cancel: () => undefined, onfinish: null, finished: new Promise(() => undefined) }
    },
  })
  return animated
}

afterEach(() => {
  const svg = SVGElement.prototype as unknown as Record<string, unknown>
  delete svg.getTotalLength
  delete svg.getPointAtLength
  delete (Element.prototype as unknown as Record<string, unknown>).animate
})

describe('filmWidth', () => {
  it('runs 3 px past the first and last frames, with no trailing gap', () => {
    expect(filmWidth(1, false, 44)).toBe(3 + 44 + 3)
    expect(filmWidth(3, false, 72)).toBe(3 + 72 + 5 + 72 + 5 + 72 + 3)
  })

  it('makes room for the enlarged current frame', () => {
    expect(filmWidth(1, true, 44)).toBe(3 + 56 + 12 + 3)
    expect(filmWidth(41, true, 44)).toBe(3 + 40 * (44 + 5) + 56 + 12 + 3)
  })

  it('is nothing for no frames', () => {
    expect(filmWidth(0, false, 44)).toBe(0)
  })
})

describe('the queue strip', () => {
  it('is as long as its film and says its cell size', () => {
    // Arrange
    stubLayout(1200, 800)

    // Act
    render(<ReviewQueue list={[photo(1)]} currentId={photo(1).id} base="" onPick={() => undefined} />)

    // Assert
    const strip = document.querySelector('.q-strip') as HTMLElement
    expect(strip.style.getPropertyValue('--film-w')).toBe(`${filmWidth(1, true, 44)}px`)
    expect(strip.style.getPropertyValue('--cell')).toBe('44px')
  })

  it('takes a larger cell for the done result', () => {
    stubLayout(1200, 800)
    render(<ReviewQueue list={[photo(1, 'confirmed'), photo(2, 'rejected')]} currentId={null} base="" cell={72} label="Reviewed photos" />)
    const strip = document.querySelector('.q-strip') as HTMLElement
    expect(strip.style.getPropertyValue('--cell')).toBe('72px')
    expect(strip.style.getPropertyValue('--film-w')).toBe(`${filmWidth(2, false, 72)}px`)
  })

  it('writes only the just-decided photo’s mark with the pen', () => {
    // Arrange
    stubLayout(1200, 800)
    const animated = stubPen()
    const list = [photo(1, 'confirmed'), photo(2, 'rejected'), photo(3, 'confirmed'), photo(4)]

    // Act
    render(<ReviewQueue list={list} currentId={photo(4).id} base="" onPick={() => undefined} justDecided={photo(3).id} />)

    // Assert
    const just = document.querySelector(`.q-item[data-id="${photo(3).id}"]`) as HTMLElement
    expect(just).toHaveAttribute('data-just', 'true')
    expect(document.querySelectorAll('[data-just]')).toHaveLength(1)
    const drawn = animated.filter((el) => el.closest('.q-item'))
    expect(drawn).toHaveLength(1)
    expect(just.contains(drawn[0] as Element)).toBe(true)
  })

  it('the result film brings the last call into view, so its pen is seen', () => {
    // Arrange
    stubLayout(400, 80)
    // jsdom has no scroll extent: give the film its length (41 frames of 72 + 5).
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(41 * 77)
    const offsets: number[] = []
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value(options: ScrollToOptions) {
        offsets.push(options.left ?? 0)
      },
    })
    const list = Array.from({ length: 41 }, (_, i) => photo(i + 1, 'confirmed'))

    // Act
    render(<ReviewQueue list={list} currentId={null} base="" cell={72} label="Reviewed photos" justDecided={photo(41).id} />)

    // Assert: scrolled toward the end of the film
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo
    expect(Math.max(0, ...offsets)).toBeGreaterThan(30 * 77)
  })

  it('draws the pen again for the next decision, on that photo only', () => {
    // Arrange
    stubLayout(1200, 800)
    const animated = stubPen()
    const list = [photo(1, 'confirmed'), photo(2, 'rejected'), photo(3)]
    const { rerender } = render(<ReviewQueue list={list} currentId={photo(3).id} base="" onPick={() => undefined} justDecided={photo(1).id} />)
    animated.length = 0

    // Act
    rerender(<ReviewQueue list={list} currentId={photo(3).id} base="" onPick={() => undefined} justDecided={photo(2).id} />)

    // Assert
    const drawn = animated.filter((el) => el.closest('.q-item'))
    expect(drawn).toHaveLength(1)
    expect(drawn[0]?.closest('.q-item')).toHaveAttribute('data-id', photo(2).id)
  })
})

// Critique round 5, P3-22: a one-photo queue was a lone frame beside a "1 / 1" count.
describe('a one-photo queue', () => {
  it('prints its counter on the rebate, as edge print', () => {
    stubLayout(800, 200)
    const { container } = render(<ReviewQueue list={[photo(1)]} currentId={photo(1).id} base="http://ftimg.localhost/" onPick={() => undefined} />)
    expect(container.querySelector('.edge')).toHaveAttribute('data-n', '▸ 01 / 01')
  })

  it('a longer queue keeps each frame’s own number', () => {
    stubLayout(800, 200)
    const { container } = render(<ReviewQueue list={[photo(1), photo(2)]} currentId={photo(1).id} base="http://ftimg.localhost/" onPick={() => undefined} />)
    expect(container.querySelector('.edge')).toHaveAttribute('data-n', '▸ 01')
  })
})
