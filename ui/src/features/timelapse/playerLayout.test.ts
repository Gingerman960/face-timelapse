// QA 30: at 960×640 the 19-frame filmstrip (870 px) and the transport were
// wider than the player and pushed the toolbar, strip and ribbon off screen.
import { describe, expect, it } from 'vitest'
import { STRIP_COLLAPSED, STRIP_H, STRIP_MAX, STRIP_MIN, fitFrameHeight, flipDelta, frameAxis, playingFrameWidth, stripCount, stripWidth } from './playerLayout'

describe('filmstrip fit', () => {
  it('matches the CSS strip: 15 frames at 3:4 are 690 px wide', () => {
    expect(stripWidth(15, 3 / 4)).toBe(690)
    expect(stripWidth(1, 3 / 4)).toBe(60)
  })

  // Critique round 5, P2-18: 19 frames (870 px) were twice the frame's width; in light the
  // strip outweighed the print. About 15 frames keep it within the stage.
  it('shows at most 15 frames, however wide the column', () => {
    expect(STRIP_MAX).toBe(15)
    expect(stripCount(870, 3 / 4)).toBe(15)
    expect(stripCount(1600, 3 / 4)).toBe(15)
  })

  it('shows the most frames that fit, an odd count from 7 to 15 so the playhead sits in the middle', () => {
    expect(stripCount(690, 3 / 4)).toBe(15)
    expect(stripCount(689, 3 / 4)).toBe(13)
    // 960×640, collapsed rail: 876 px main column, 20 px player padding each side.
    expect(stripCount(836, 3 / 4)).toBe(15)
    // The same window with the inspector open (268 px).
    expect(stripCount(568, 3 / 4)).toBe(11)
    // Wider frames fit fewer.
    expect(stripCount(568, 4 / 5)).toBe(11)
    expect(stripCount(568, 1)).toBe(9)
    // Never fewer than 7: the strip clips instead.
    expect(stripCount(10, 3 / 4)).toBe(STRIP_MIN)
    expect(STRIP_MIN).toBe(7)
    expect(stripCount(5000, 3 / 4)).toBe(STRIP_MAX)
  })

  it('shows the full strip until the width is known', () => {
    expect(stripCount(0, 3 / 4)).toBe(STRIP_MAX)
    expect(stripCount(Number.NaN, 3 / 4)).toBe(STRIP_MAX)
  })
})

// With the inspector open, a tall frame was wider than the stage could give it
// beside the plate caption and was drawn over the caption.
describe('frame fit', () => {
  it('keeps the stage height while the frame and caption fit side by side', () => {
    // 1440×900 with the inspector: a 828 px stage, 606 px tall, 336 px reserved for the caption.
    expect(fitFrameHeight(828, 606, 3 / 4, 336)).toBeNull()
  })

  it('shortens the frame so it fits beside the caption', () => {
    // 1300×900 with the inspector: 688 px wide leaves 352 px for a 3:4 frame.
    expect(fitFrameHeight(688, 588, 3 / 4, 336)).toBe(469)
    // 960×1000 with the inspector: 568 px wide, 248 px reserved (≤ 1180 px layout).
    expect(fitFrameHeight(568, 688, 3 / 4, 248)).toBe(426)
    // The same 1440×900 stage while playing (74 + 12 px taller): now the width binds.
    expect(fitFrameHeight(828, 692, 3 / 4, 336)).toBe(656)
  })

  it('never goes below zero and waits for a measured stage', () => {
    expect(fitFrameHeight(200, 600, 3 / 4, 336)).toBe(0)
    expect(fitFrameHeight(0, 600, 3 / 4, 336)).toBeNull()
    expect(fitFrameHeight(800, 0, 3 / 4, 336)).toBeNull()
  })
})

// Critique round 4, P1-2: the filmstrip fades out while playing and the frame takes its
// 74 px. The frame's images are fetched for its size while playing in both states, so
// pressing Space never switches the image size (and refetches the ring buffer).
describe('the frame while playing', () => {
  it('mirrors the CSS: a 74 px strip that leaves a 12 px gap when it folds away', () => {
    expect(STRIP_H).toBe(74)
    expect(STRIP_COLLAPSED).toBe(12)
  })

  it('is as tall as the player less the transport and the folded strip, at the frame aspect', () => {
    // 1440×900, no inspector: a 1124 px column, 698 px tall, a 46 px transport.
    expect(playingFrameWidth({ columnWidth: 1124, contentHeight: 698, transportHeight: 46, aspect: 3 / 4, reserve: 336 })).toBe(480)
  })

  it('stays beside the caption: a narrow column caps it by width, as fitFrameHeight does', () => {
    // 1300×900 with the inspector: 688 px wide leaves 352 px for a 3:4 frame.
    expect(playingFrameWidth({ columnWidth: 688, contentHeight: 698, transportHeight: 46, aspect: 3 / 4, reserve: 336 })).toBe(352)
  })

  it('is 0 until the player is laid out, and never negative', () => {
    expect(playingFrameWidth({ columnWidth: 0, contentHeight: 698, transportHeight: 46, aspect: 3 / 4, reserve: 336 })).toBe(0)
    expect(playingFrameWidth({ columnWidth: 1200, contentHeight: 800, transportHeight: 800, aspect: 3 / 4, reserve: 0 })).toBe(0)
    expect(playingFrameWidth({ columnWidth: 200, contentHeight: 698, transportHeight: 46, aspect: 3 / 4, reserve: 336 })).toBe(0)
  })
})

// The frame grows into the strip's place by transform (FLIP), never by animating its size.
describe('flip delta', () => {
  it('maps the new box back onto the old one: translate then scale, from the top left', () => {
    const first = { left: 300, top: 60, width: 450, height: 600 }
    const last = { left: 280, top: 60, width: 516, height: 688 }
    const d = flipDelta(first, last)
    expect(d?.x).toBe(20)
    expect(d?.y).toBe(0)
    expect(d?.sx).toBeCloseTo(450 / 516, 6)
    expect(d?.sy).toBeCloseTo(600 / 688, 6)
  })

  it('moves a box that only changes place (the caption) without scaling it', () => {
    expect(flipDelta({ left: 800, top: 300, width: 240, height: 200 }, { left: 822, top: 386, width: 240, height: 200 })).toEqual({ x: -22, y: -86, sx: 1, sy: 1 })
  })

  it('skips boxes that did not move or are not laid out', () => {
    expect(flipDelta({ left: 10, top: 10, width: 100, height: 100 }, { left: 10.2, top: 10, width: 100.3, height: 100 })).toBeNull()
    expect(flipDelta({ left: 0, top: 0, width: 0, height: 0 }, { left: 10, top: 10, width: 100, height: 100 })).toBeNull()
  })
})

// P2-11: the transport and filmstrip were centred on the column, not on the frame.
describe('frame axis', () => {
  it('gives the frame centre from the column’s left edge, and the column width', () => {
    expect(frameAxis({ left: 300, width: 441 }, { left: 252, width: 1124 }, 32)).toEqual({ cx: 236.5, columnWidth: 1124 - 64 })
  })

  it('is null before layout', () => {
    expect(frameAxis({ left: 0, width: 0 }, { left: 0, width: 800 }, 0)).toBeNull()
    expect(frameAxis({ left: 0, width: 300 }, { left: 0, width: 0 }, 0)).toBeNull()
  })
})
