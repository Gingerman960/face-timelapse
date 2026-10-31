// Critique round 5, P2-16: the encoding print could swap its source every frame. It now changes
// only when its (stepped) source does, and each new image cross-fades in over the one shown.
import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { EncodingPrint } from './Prints'

describe('EncodingPrint', () => {
  it('develops its first image from latent film, then cross-fades each new one in over the shown one', () => {
    // Arrange
    const { container, rerender } = render(<EncodingPrint src="day-1.jpg" />)
    const images = () => [...container.querySelectorAll('img')]
    const srcs = () => images().map((img) => img.getAttribute('src'))

    // Assert: latent film until the image is in, then it develops.
    expect(container.firstElementChild).toHaveClass('export-print', 'enc-print')
    expect(srcs()).toEqual(['day-1.jpg'])
    expect(images()[0]).not.toHaveAttribute('data-shown')
    fireEvent.load(images()[0] as HTMLElement)
    expect(images()[0]).toHaveAttribute('data-shown')
    expect(images()[0]).toHaveAttribute('data-develop')

    // Act: the next step loads under the shown print.
    rerender(<EncodingPrint src="day-14.jpg" />)

    // Assert: the shown print stays until the new one is in, so the print never blinks.
    expect(srcs()).toEqual(['day-1.jpg', 'day-14.jpg'])
    expect(images()[0]).toHaveAttribute('data-shown')
    expect(images()[1]).not.toHaveAttribute('data-shown')

    // Act: another step before that image landed replaces it rather than stacking.
    rerender(<EncodingPrint src="day-27.jpg" />)
    expect(srcs()).toEqual(['day-1.jpg', 'day-27.jpg'])
    fireEvent.load(images()[1] as HTMLElement)

    // Assert: it cross-fades in (no develop), and the next step drops the print under it.
    expect(images()[1]).toHaveAttribute('data-shown')
    expect(images()[1]).not.toHaveAttribute('data-develop')
    rerender(<EncodingPrint src="day-40.jpg" />)
    expect(srcs()).toEqual(['day-27.jpg', 'day-40.jpg'])
  })

  it('the same source keeps the print as it is', () => {
    const { container, rerender } = render(<EncodingPrint src="day-1.jpg" />)
    fireEvent.load(container.querySelector('img') as HTMLElement)
    rerender(<EncodingPrint src="day-1.jpg" />)
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })

  it('is bare latent film before there is a day to show', () => {
    const { container } = render(<EncodingPrint src={null} />)
    expect(container.querySelector('img')).toBeNull()
  })
})
