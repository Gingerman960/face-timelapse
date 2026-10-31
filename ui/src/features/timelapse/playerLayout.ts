// How the player fits its column (QA 30, critique round 4 P1-2): the filmstrip
// shows as many frames as fit, folds away while playing, and the frame takes
// its place. The geometry mirrors timelapse.css (.player, .filmstrip, .film).

/**
 * Frames on the strip when there is room: about 15, so the strip stays within
 * its stage (critique round 5, P2-18: 19 frames were twice the frame's width,
 * and in light the black strip outweighed the print).
 */
export const STRIP_MAX = 15
/** Fewest frames on the strip; a narrower strip clips instead. */
export const STRIP_MIN = 7
/** The strip's height: 15 px of edge print, a 56 px frame, 3 px of rebate. */
export const STRIP_H = 74
/** What is left of the strip's row while it is folded away (playing): the gap above the transport. */
export const STRIP_COLLAPSED = 12
/** Height of a strip frame: the strip less 15 px of edge print above and 3 px below. */
const FILM_H = 56
const FILM_GAP = 3
const STRIP_PAD = 3
/** The current frame stands apart by this margin on each side. */
const NOW_MARGIN = 6

/** CSS width of a strip of `n` frames whose width ÷ height is `aspect`. */
export function stripWidth(n: number, aspect: number): number {
  return 2 * STRIP_PAD + n * FILM_H * aspect + (n - 1) * FILM_GAP + 2 * NOW_MARGIN
}

/**
 * Frames to show on a strip `width` CSS px wide: the most that fit, from 7 to
 * 15, and odd so the playhead sits in the middle. The full strip until the
 * width is known (0 before layout).
 */
export function stripCount(width: number, aspect: number): number {
  if (!(width > 0)) return STRIP_MAX
  for (let n = STRIP_MAX; n > STRIP_MIN; n -= 2) {
    if (stripWidth(n, aspect) <= width) return n
  }
  return STRIP_MIN
}

interface Span {
  left: number
  width: number
}

/**
 * The frame's vertical axis in the player column: its centre measured from the
 * column's left edge, and the column's width (the player less its padding).
 * The transport and the filmstrip centre on it (P2-11). Null before layout.
 */
export function frameAxis(frame: Span, player: Span, padLeft: number, padRight: number = padLeft): { cx: number; columnWidth: number } | null {
  const columnWidth = player.width - padLeft - padRight
  if (!(frame.width > 0) || !(columnWidth > 0)) return null
  return { cx: frame.left + frame.width / 2 - (player.left + padLeft), columnWidth }
}

/**
 * Height of the frame on a `stageW` × `stageH` stage so that it fits beside the
 * plate caption, which needs `reserve` px (its minimum column, the lead column
 * and the gaps); null keeps the stage height (the frame already fits, or the
 * stage is not measured yet).
 */
export function fitFrameHeight(stageW: number, stageH: number, aspect: number, reserve: number): number | null {
  if (!(stageW > 0 && stageH > 0 && aspect > 0)) return null
  const byWidth = (stageW - reserve) / aspect
  return byWidth < stageH ? Math.max(0, Math.floor(byWidth)) : null
}

interface PlayingFrameInput {
  /** The player column's width (inside its padding). */
  columnWidth: number
  /** The player's height inside its padding. */
  contentHeight: number
  transportHeight: number
  /** Frame width ÷ height. */
  aspect: number
  /** What the plate caption needs beside the frame: its minimum column, the lead column and the gaps. */
  reserve: number
}

/**
 * Width of the frame while playing (strip folded away): the player's height
 * less the transport and the folded strip's gap, capped so the frame stays
 * beside the caption (fitFrameHeight). It reads only sizes that
 * playing doesn't change, so the frame's image size is the same paused and
 * playing. 0 before layout.
 */
export function playingFrameWidth({ columnWidth, contentHeight, transportHeight, aspect, reserve }: PlayingFrameInput): number {
  if (!(columnWidth > 0 && contentHeight > 0 && aspect > 0)) return 0
  const tall = contentHeight - transportHeight - STRIP_COLLAPSED
  const byWidth = (columnWidth - reserve) / aspect
  return Math.max(0, Math.round(Math.min(tall, byWidth) * aspect))
}

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Below this a box counts as unmoved (sub-pixel layout noise). */
const FLIP_EPSILON = 0.5

/**
 * The inverse transform (origin top left) that puts a box laid out at `last`
 * back where it was drawn at `first`, so it can animate home to none; null
 * when it didn't move or isn't laid out.
 */
export function flipDelta(first: Box, last: Box): { x: number; y: number; sx: number; sy: number } | null {
  if (!(first.width > 0 && first.height > 0 && last.width > 0 && last.height > 0)) return null
  const x = first.left - last.left
  const y = first.top - last.top
  const grew = Math.abs(first.width - last.width) >= FLIP_EPSILON || Math.abs(first.height - last.height) >= FLIP_EPSILON
  if (!grew && Math.abs(x) < FLIP_EPSILON && Math.abs(y) < FLIP_EPSILON) return null
  return { x, y, sx: grew ? first.width / last.width : 1, sy: grew ? first.height / last.height : 1 }
}
