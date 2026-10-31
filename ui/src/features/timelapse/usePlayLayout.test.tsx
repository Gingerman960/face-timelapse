// Critique round 4, P1-2: the filmstrip folds away while playing and the frame
// takes its place. The layout switch is one attribute (`.player[data-playing]`,
// read by the CSS); the frame and caption travel to their new boxes by
// transform (FLIP), never by animating their size.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useRef } from 'react'
import { usePlayer } from '../../state/player'
import { usePlayLayout } from './usePlayLayout'

const initial = usePlayer.getState()

function Stage({ refit }: { refit?: () => void }) {
  const player = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLElement>(null)
  const caption = useRef<HTMLDivElement>(null)
  usePlayLayout(player, frame, caption, refit)
  return (
    <div ref={player} className="player" data-testid="player">
      <figure ref={frame} className="frame" />
      <div ref={caption} className="cap-col" />
    </div>
  )
}

const player = () => document.querySelector<HTMLElement>('.player') as HTMLElement
const toggle = () => act(() => usePlayer.getState().toggle())

type Rect = { left: number; top: number; width: number; height: number }

/** Boxes that follow the layout attribute, like the CSS: playing grows the frame and moves the caption down. */
function layoutByAttribute(paused: { frame: Rect; caption: Rect }, playing: { frame: Rect; caption: Rect }) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const state = this.closest<HTMLElement>('.player')?.dataset.playing === 'true' ? playing : paused
    const r = this.classList.contains('frame') ? state.frame : state.caption
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => ({}) } as DOMRect
  })
}

function stubAnimate() {
  const finishers: Array<() => void> = []
  const animate = vi.fn(function () {
    let finish: () => void = () => undefined
    const finished = new Promise<void>((resolve) => (finish = resolve))
    finishers.push(() => finish())
    return { cancel: vi.fn(), finished } as unknown as Animation
  })
  Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true, writable: true })
  return { animate, finishAll: () => finishers.forEach((f) => f()) }
}

const PAUSED = { frame: { left: 300, top: 60, width: 450, height: 600 }, caption: { left: 790, top: 400, width: 240, height: 260 } }
const PLAYING = { frame: { left: 278, top: 60, width: 516, height: 688 }, caption: { left: 834, top: 488, width: 240, height: 260 } }

beforeEach(() => {
  usePlayer.setState(initial, true)
})
afterEach(() => {
  delete (HTMLElement.prototype as { animate?: unknown }).animate
})

describe('the player while playing', () => {
  it('marks the layout paused or playing, following the store', () => {
    // Arrange
    render(<Stage />)
    expect(player()).toHaveAttribute('data-playing', 'false')

    // Act + Assert
    toggle()
    expect(player()).toHaveAttribute('data-playing', 'true')
    toggle()
    expect(player()).toHaveAttribute('data-playing', 'false')
  })

  it('grows the frame into the strip’s place by transform from its old box, and carries the caption along', async () => {
    // Arrange
    layoutByAttribute(PAUSED, PLAYING)
    const { animate, finishAll } = stubAnimate()
    render(<Stage />)

    // Act
    toggle()

    // Assert: each box starts where it was drawn and travels home.
    expect(animate).toHaveBeenCalledTimes(2)
    const [frameKeys, frameTiming] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions]
    expect(frameKeys[0]).toMatchObject({ transformOrigin: '0 0', transform: `translate(22px, 0px) scale(${450 / 516}, ${600 / 688})` })
    expect(frameKeys[1]).toMatchObject({ transform: 'none' })
    expect(frameTiming).toMatchObject({ duration: 360 })
    const [captionKeys] = animate.mock.calls[1] as unknown as [Keyframe[]]
    expect(captionKeys[0]).toMatchObject({ transform: 'translate(-44px, -88px) scale(1, 1)' })
    // The transport eases to the frame's new axis while the boxes travel.
    expect(player()).toHaveAttribute('data-flipping')
    await act(async () => finishAll())
    expect(player()).not.toHaveAttribute('data-flipping')
  })

  // At 1440×900 with the inspector open the playing frame is capped beside the caption:
  // the cap must be final before the new boxes are measured, or the frame jumps mid-travel.
  it('re-fits the frame beside the caption in the same pass, before measuring where the boxes went', () => {
    // Arrange
    layoutByAttribute(PAUSED, PLAYING)
    const { animate } = stubAnimate()
    const seen: string[] = []
    const refit = vi.fn(() => seen.push(`${player().dataset.playing}:${animate.mock.calls.length}`))
    render(<Stage refit={refit} />)

    // Act
    toggle()

    // Assert: after the switch, before any travel starts.
    expect(seen).toEqual(['true:0'])
    expect(animate).toHaveBeenCalledTimes(2)
  })

  it('jumps without travel under reduced motion', () => {
    // Arrange
    layoutByAttribute(PAUSED, PLAYING)
    const { animate } = stubAnimate()
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: query.includes('reduce'), media: query }) as MediaQueryList)
    render(<Stage />)

    // Act
    toggle()

    // Assert
    expect(player()).toHaveAttribute('data-playing', 'true')
    expect(animate).not.toHaveBeenCalled()
  })

  it('does not travel while the frame is the full-window viewer', () => {
    // Arrange
    layoutByAttribute(PAUSED, PLAYING)
    const { animate } = stubAnimate()
    act(() => usePlayer.getState().setViewer(true))
    render(<Stage />)

    // Act
    toggle()

    // Assert
    expect(animate).not.toHaveBeenCalled()
  })

  it('removes its marks when the player goes away', () => {
    // Arrange
    const { unmount } = render(<Stage />)
    const el = player()

    // Act
    unmount()

    // Assert
    expect(el).not.toHaveAttribute('data-playing')
  })
})
