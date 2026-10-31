// Critique round 4: the Days drag ghost teleported on drop; it now settles into the day.
import { describe, expect, it, vi } from 'vitest'
import { dropSettle } from './dropSettle'

const at = { x: 120, y: 40, scaleX: 1, scaleY: 1 }

describe('the drop settle', () => {
  it('shrinks and fades the ghost where it was let go, over 220 ms', () => {
    const settle = dropSettle()
    expect(settle).toMatchObject({ duration: 220 })
    const keyframes = settle?.keyframes({ transform: { initial: at, final: { x: 0, y: 0, scaleX: 1, scaleY: 1 } } } as never)
    expect(keyframes).toEqual([
      { opacity: 1, transform: 'translate3d(120px, 40px, 0) scaleX(1) scaleY(1)' },
      { opacity: 0, transform: 'translate3d(120px, 40px, 0) scaleX(0.72) scaleY(0.72)' },
    ])
  })

  it('does not move under reduced motion', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    expect(dropSettle()).toBeNull()
  })
})
