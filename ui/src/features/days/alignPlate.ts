import type { FramesInfo } from '../../ipc/contract'
import { countOf } from '../../lib/format'

/** Shown when the frames info can't say how many days still need aligning. */
export const ALIGN_AGAIN = 'Align again'

/**
 * The days an align would actually render, from the session's frames info:
 * every active day before the first align (`none`) or after a change that
 * invalidates all frames (`stale`); only the days without a current frame
 * when some exist (`partial`: expected − count). Null when the info is
 * inconsistent (a `partial` with nothing missing) or there is nothing to do.
 */
export function daysToAlign(frames: FramesInfo, activeDays: number): number | null {
  switch (frames.status) {
    case 'none':
      return activeDays
    case 'stale':
      return frames.expected
    case 'partial': {
      const missing = frames.expected - frames.count
      return missing > 0 ? missing : null
    }
    case 'complete':
      return null
  }
}

/** The Days plate before the timelapse is complete: "Align 3,547 days", "Re-align 1 day", or "Align again". */
export function alignPlateLabel(frames: FramesInfo, activeDays: number): string {
  const n = daysToAlign(frames, activeDays)
  if (n === null) return ALIGN_AGAIN
  return `${frames.status === 'none' ? 'Align' : 'Re-align'} ${countOf(n, 'day')}`
}
