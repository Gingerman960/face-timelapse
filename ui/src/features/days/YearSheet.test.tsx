// Critique round 5, P1-5: at 1920 the year block ended about 400 pt short of the
// canvas and the legend floated over nothing. With cells sized to the height,
// the year now lies centred as one sheet and reports its width for the head.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { YearView } from './CalendarViews'
import { stubLayout } from '../../test/layout'

afterEach(() => vi.restoreAllMocks())

const view = { byDay: new Map(), photos: new Map(), base: 'http://ftimg.localhost/', activeDay: '2013-01-17', dragSource: null, moveTarget: null, range: { first: '2013-01-01', last: '2013-12-31' }, onSelect: () => undefined }

/** A canvas `width` × `height` that the year grid sits in (its offset parent). */
function canvas(width: number, height: number) {
  stubLayout(width, height)
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
    return this.parentElement
  })
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockReturnValue(120)
}

function year(onSheet: (px: number | null) => void) {
  return render(
    <div className="days-canvas">
      <YearView year={2013} focusDay="2013-01-17" onSheet={onSheet} {...view} />
    </div>,
  ).container.querySelector('.year-grid') as HTMLElement
}

describe('the year as one sheet', () => {
  it('lies centred and reports its width when its cells are sized to the height', () => {
    // Arrange: a wide, short canvas (1920 with the inspector open).
    canvas(1340, 860)
    const onSheet = vi.fn()

    // Act
    const grid = year(onSheet)

    // Assert
    expect(grid).toHaveAttribute('data-sheet', 'true')
    const px = onSheet.mock.lastCall?.[0] as number
    expect(px).toBeGreaterThan(800)
    expect(px).toBeLessThan(1340)
  })

  it('fills its columns, with no sheet, when the width limits the cells', () => {
    canvas(900, 4000)
    const onSheet = vi.fn()
    const grid = year(onSheet)
    expect(grid).not.toHaveAttribute('data-sheet')
    expect(onSheet).toHaveBeenLastCalledWith(null)
  })
})
