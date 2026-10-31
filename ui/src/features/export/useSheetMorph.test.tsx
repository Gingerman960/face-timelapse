// Critique round 4 (P1-3): the export sheet used to hard-swap its phases and snap
// its height. It now morphs: the edge moves with clip-path, the shade carries the
// shadow along, and the outgoing content cross-fades with the new one.
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { installFakeAnimations, removeFakeAnimations, type FakeCall } from '../../components/ui/fakeAnimations'
import { insetBottom, useSheetMorph } from './useSheetMorph'

const HEIGHTS: Record<string, number> = { settings: 300, done: 500, encoding: 200 }

function Harness({ phase }: { phase: string }) {
  const sheet = useRef<HTMLElement>(null)
  const shade = useRef<HTMLDivElement>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const phaseRef = useSheetMorph(sheet, shade, ghost, phase)
  return (
    <div className="sheet-frame">
      <div ref={shade} className="sheet-shade" />
      <section ref={sheet} className="sheet" style={{ borderTopLeftRadius: '18px' }}>
        <div key={phase} ref={phaseRef} className="sheet-phase" data-h={HEIGHTS[phase]}>
          <p id={`${phase}-copy`}>{phase} body</p>
        </div>
        <div ref={ghost} className="sheet-ghost" aria-hidden="true" />
      </section>
    </div>
  )
}

function rect(height: number): DOMRect {
  return { x: 0, y: 0, left: 0, top: 0, right: 720, bottom: height, width: 720, height, toJSON: () => ({}) } as DOMRect
}

/** The sheet is as tall as its phase's content, or its min-height while one holds it. */
function fakeSheetHeights(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('sheet')) return rect(0)
    const content = Number(this.querySelector(':scope > .sheet-phase')?.getAttribute('data-h') ?? 0)
    return rect(Math.max(content, Number.parseFloat(this.style.minHeight) || 0))
  })
}

const on = (calls: FakeCall[], selector: string) => calls.filter((c) => c.target.matches(selector))
const sheetEl = () => document.querySelector('.sheet') as HTMLElement
const ghostEl = () => document.querySelector('.sheet-ghost') as HTMLElement

afterEach(() => {
  removeFakeAnimations()
})

describe('useSheetMorph', () => {
  it('does nothing on the first phase, nor where the browser cannot animate', () => {
    fakeSheetHeights()
    const { rerender } = render(<Harness phase="settings" />)
    rerender(<Harness phase="done" />)
    expect(ghostEl().childElementCount).toBe(0)
    expect(sheetEl().style.minHeight).toBe('')
  })

  it('growing: the edge moves down from the old height, the shade follows, the content cross-fades', async () => {
    // Arrange
    fakeSheetHeights()
    const fake = installFakeAnimations()
    const { rerender } = render(<Harness phase="settings" />)
    expect(fake.calls).toEqual([])

    // Act
    rerender(<Harness phase="done" />)

    // Assert: the clip runs 300 → 500 over 360 ms on --ease-sheet.
    const [clip] = on(fake.calls, '.sheet')
    expect(clip?.keyframes).toEqual([{ clipPath: 'inset(0px 0px 200px 0px round 18px)' }, { clipPath: 'inset(0px 0px 0px 0px round 18px)' }])
    expect(clip?.options).toMatchObject({ duration: 360, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' })
    const [shade] = on(fake.calls, '.sheet-shade')
    expect(shade?.keyframes).toEqual([
      { transform: 'translateY(-200px)', clipPath: 'inset(200px -160px -160px -160px)' },
      { transform: 'translateY(0px)', clipPath: 'inset(0px -160px -160px -160px)' },
    ])
    expect(sheetEl()).toHaveAttribute('data-morph', 'true')
    expect(sheetEl().style.willChange).toBe('clip-path')

    // The new content fades in and a copy of the old one, without its ids, fades out over 120 ms.
    expect(on(fake.calls, '.sheet > .sheet-phase')[0]).toMatchObject({ keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 120 } })
    const copy = ghostEl().firstElementChild as HTMLElement
    expect(copy).toHaveTextContent('settings body')
    expect(copy.querySelector('[id]')).toBeNull()
    expect(fake.calls.find((c) => c.target === copy)).toMatchObject({ keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: 120 } })

    // Act
    await act(async () => fake.finishAll())

    // Assert: everything it set is gone again.
    expect(ghostEl().childElementCount).toBe(0)
    expect(sheetEl()).not.toHaveAttribute('data-morph')
    expect(sheetEl().style.willChange).toBe('')
    expect(fake.animations.every((a) => a.cancel.mock.calls.length > 0)).toBe(true)
  })

  it('shrinking: the box keeps the old height while the edge comes up, then lets go', async () => {
    fakeSheetHeights()
    const fake = installFakeAnimations()
    const { rerender } = render(<Harness phase="settings" />)

    rerender(<Harness phase="encoding" />)

    expect(sheetEl().style.minHeight).toBe('300px')
    expect(on(fake.calls, '.sheet')[0]?.keyframes).toEqual([{ clipPath: 'inset(0px 0px 0px 0px round 18px)' }, { clipPath: 'inset(0px 0px 100px 0px round 18px)' }])
    expect(on(fake.calls, '.sheet-shade')[0]?.keyframes).toEqual([
      { transform: 'translateY(0px)', clipPath: 'inset(0px -160px -160px -160px)' },
      { transform: 'translateY(-100px)', clipPath: 'inset(100px -160px -160px -160px)' },
    ])
    await act(async () => fake.finishAll())
    expect(sheetEl().style.minHeight).toBe('')
  })

  it('a phase that arrives mid-morph starts from the edge where it is', () => {
    fakeSheetHeights()
    const fake = installFakeAnimations()
    const { rerender } = render(<Harness phase="settings" />)
    rerender(<Harness phase="done" />)
    // Halfway: the browser reports the clip as it is now.
    sheetEl().style.clipPath = 'inset(0px 0px 120px 0px round 18px)'

    rerender(<Harness phase="encoding" />)

    // 500 tall, 120 clipped: the edge was at 380; it now comes up to 200.
    expect(fake.animations.slice(0, 4).every((a) => a.cancelled)).toBe(true)
    expect(sheetEl().style.minHeight).toBe('380px')
    expect(on(fake.calls, '.sheet').at(-1)?.keyframes).toEqual([{ clipPath: 'inset(0px 0px 0px 0px round 18px)' }, { clipPath: 'inset(0px 0px 180px 0px round 18px)' }])
    expect(ghostEl().childElementCount).toBe(1)
  })

  it('keeps the outgoing copy where it was scrolled to', () => {
    fakeSheetHeights()
    installFakeAnimations()
    const { rerender } = render(<Harness phase="settings" />)
    sheetEl().scrollTop = 40
    fireEvent.scroll(sheetEl())

    rerender(<Harness phase="done" />)

    expect(ghostEl().style.top).toBe('-40px')
    expect(sheetEl().scrollTop).toBe(0)
  })

  it('only cross-fades under reduced motion', () => {
    fakeSheetHeights()
    const fake = installFakeAnimations()
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    const { rerender } = render(<Harness phase="settings" />)

    rerender(<Harness phase="done" />)

    expect(fake.calls.every((c) => c.keyframes.every((k) => Object.keys(k).join() === 'opacity'))).toBe(true)
    expect(fake.calls).toHaveLength(2)
    expect(sheetEl()).not.toHaveAttribute('data-morph')
  })

  it('stops a running morph when the sheet goes', () => {
    fakeSheetHeights()
    const fake = installFakeAnimations()
    const { rerender, unmount } = render(<Harness phase="settings" />)
    rerender(<Harness phase="done" />)
    unmount()
    expect(fake.animations.every((a) => a.cancelled)).toBe(true)
  })
})

describe('insetBottom', () => {
  it('reads the bottom inset of a computed clip, in any shorthand', () => {
    expect(insetBottom('inset(0px 0px 42.5px 0px round 18px)')).toBe(42.5)
    expect(insetBottom('inset(0px 0px 7px)')).toBe(7)
    expect(insetBottom('inset(3px 1px)')).toBe(3)
    expect(insetBottom('inset(5px)')).toBe(5)
    expect(insetBottom('none')).toBeNull()
    expect(insetBottom('')).toBeNull()
  })
})
