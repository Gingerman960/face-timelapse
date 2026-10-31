// UI review 2, L4: month ids are 1–12 in every year, so after switching to a
// shorter year the months that no longer exist stayed "visible" and the
// ribbon's bracket ran past the library's end.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useRef } from 'react'
import { useOnScreen } from './useOnScreen'

class FakeObserver {
  static all: FakeObserver[] = []
  readonly targets = new Set<Element>()
  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeObserver.all.push(this)
  }
  observe(el: Element) {
    this.targets.add(el)
  }
  unobserve(el: Element) {
    this.targets.delete(el)
  }
  disconnect() {
    this.targets.clear()
  }
  takeRecords() {
    return []
  }
  /** Reports every observed section; `on` decides which intersect. */
  report(on: (id: number) => boolean) {
    const entries = [...this.targets].map((target) => ({ target, isIntersecting: on(Number(target.getAttribute('data-m'))) }) as IntersectionObserverEntry)
    act(() => this.cb(entries, this as unknown as IntersectionObserver))
  }
}

/** The visible ids, as the component rendered them. */
const seen = () => (document.querySelector('output')?.dataset.visible ?? '').split(',').filter(Boolean).map(Number)

function Months({ ids, layoutKey }: { ids: number[]; layoutKey: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const { visible } = useOnScreen(ref, '[data-m]', 'data-m', layoutKey)
  return (
    <div className="days-canvas">
      <output data-visible={[...visible].sort((a, b) => a - b).join(',')} />
      <div ref={ref}>
        {ids.map((id) => (
          <section key={id} data-m={id} />
        ))}
      </div>
    </div>
  )
}

afterEach(() => {
  FakeObserver.all = []
})

describe('useOnScreen when the sections change', () => {
  it('forgets the sections of the previous layout', () => {
    // Arrange: a full year, every month on screen.
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const months = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
    const { rerender } = render(<Months ids={months(12)} layoutKey="2021" />)
    for (const o of FakeObserver.all) o.report(() => true)
    expect(seen()).toHaveLength(12)

    // Act: the library's last year has eight months; only May–August are on screen.
    rerender(<Months ids={months(8)} layoutKey="2022" />)
    for (const o of FakeObserver.all.slice(-2)) o.report((id) => id >= 5)

    // Assert
    expect(seen()).toEqual([5, 6, 7, 8])
    vi.unstubAllGlobals()
  })
})
