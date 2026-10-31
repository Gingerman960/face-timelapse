// Critique round 4: decisions are written with the pen (a stroke from its first
// point to its last), not wiped in from the left, and only the mark just made.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { StrikeMark, TickMark, UnderlineMark, screenLength } from './Mark'

type Fake = { getTotalLength: () => number; getPointAtLength: (d: number) => { x: number; y: number }; animate: ReturnType<typeof vi.fn> }

/** Gives SVG paths the geometry and WAAPI jsdom lacks: a straight 100-unit line in a 200 × 50 px box. */
function fakeGeometry(): ReturnType<typeof vi.fn> {
  const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }))
  const proto = SVGElement.prototype as unknown as Fake
  Object.assign(proto, {
    getTotalLength: () => 100,
    getPointAtLength: (d: number) => ({ x: d, y: 0 }),
    animate,
  })
  vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 50 } as DOMRect)
  return animate
}

afterEach(() => {
  const proto = SVGElement.prototype as unknown as Partial<Fake>
  delete proto.getTotalLength
  delete proto.getPointAtLength
  delete proto.animate
})

describe('chinagraph marks', () => {
  it('measure their stroke on screen (the stroke does not scale with the box)', () => {
    fakeGeometry()
    const { container } = render(<TickMark />)
    // 100 units across a 200 px wide box is 200 px, plus 2 px slack.
    expect(screenLength(container.querySelector('path') as SVGPathElement)).toBeCloseTo(202)
  })

  it('are written by the pen only when drawn, from the first point to the last', () => {
    const animate = fakeGeometry()
    render(<StrikeMark />)
    expect(animate).not.toHaveBeenCalled()

    const { container } = render(<TickMark draw />)
    const path = container.querySelector('path') as SVGPathElement
    expect(path.style.strokeDasharray).toBe('202 202')
    expect(animate).toHaveBeenCalledWith([{ strokeDashoffset: 202 }, { strokeDashoffset: 0 }], expect.objectContaining({ duration: 360, fill: 'backwards' }))
  })

  it('fade in instead under reduced motion', () => {
    const animate = fakeGeometry()
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    render(<UnderlineMark draw />)
    expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 120 }))
  })

  it('draw nothing extra where SVG geometry is missing', () => {
    const { container } = render(<TickMark draw neutral className="big" />)
    expect(container.querySelector('svg')).toHaveClass('mark', 'neutral', 'big')
    expect((container.querySelector('path') as SVGPathElement).style.strokeDasharray).toBe('')
  })
})
