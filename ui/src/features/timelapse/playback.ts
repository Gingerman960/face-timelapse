// Pure stepping of the player clock. The player walks the same output
// timeline the export encodes (lib/video.ts `crossfadePlan`: holds, each photo,
// its blend frames), so playback speed equals the video's pace.
import type { FramePlan, PlanFrame } from '../../lib/video'

/** Longest gap between two display frames the clock catches up on (a hidden window resumes where it was). */
export const MAX_TICK_MS = 250
/** How often the ~4 Hz `settled` index follows playback. */
export const SETTLE_MS = 250

export interface Clock {
  /** Output frame on screen. */
  readonly out: number
  /** Share of the next output frame already elapsed; 1 while held for a frame that is still decoding. */
  readonly acc: number
}

export interface TickInput {
  readonly plan: FramePlan
  /** Output frames per second. */
  readonly fps: number
  /** Shuttle rate; negative plays backwards. */
  readonly rate: number
  readonly loop: boolean
  /** True when every photo `frame` needs can be shown (decoded, or failed and therefore skipped). */
  readonly canShow: (frame: PlanFrame) => boolean
}

export interface TickResult extends Clock {
  /** Playback reached an end of the timeline and does not loop. */
  readonly ended: boolean
}

/**
 * Advances the clock by `elapsedMs`. It moves one output frame at a time and
 * holds (never skips) while the next frame's photos are still decoding, so
 * motion stays even; at an end it wraps when looping.
 */
export function advance(clock: Clock, elapsedMs: number, input: TickInput): TickResult {
  const { plan, fps, rate, loop, canShow } = input
  const total = plan.totalFrames
  if (total === 0) return { out: 0, acc: 0, ended: true }
  const dir = rate < 0 ? -1 : 1
  const elapsed = Math.min(MAX_TICK_MS, Math.max(0, elapsedMs))
  let out = clock.out
  // After a hold the waiting frame shows at once; time spent waiting is not caught up.
  let acc = clock.acc >= 1 ? 1 : clock.acc + (elapsed / 1000) * fps * Math.abs(rate)
  while (acc >= 1) {
    let next = out + dir
    if (next < 0 || next >= total) {
      if (!loop) return { out, acc: 0, ended: true }
      next = dir > 0 ? 0 : total - 1
    }
    const frame = plan.frameAt(next)
    if (!frame || !canShow(frame)) return { out, acc: Math.min(acc, 1), ended: false }
    out = next
    acc -= 1
  }
  return { out, acc, ended: false }
}

/** The photo the UI reports while output frame `out` shows: the photo a blend starts from. */
export function photoAt(plan: FramePlan, out: number): number {
  return plan.frameAt(out)?.a ?? 0
}

/** Output frame where `photo` is shown unblended (clamped into the plan). */
export function outputOf(plan: FramePlan, photo: number): number {
  const last = Math.max(0, plan.totalFrames > 0 ? (plan.frameAt(plan.totalFrames - 1)?.a ?? 0) : 0)
  return plan.outputIndexOf(Math.max(0, Math.min(last, Math.round(photo)))) ?? 0
}

/**
 * Where playback from `photo` starts: the very start of the video for the
 * first photo, so its first hold plays as in the export (UI review 2, L1),
 * else the photo's unblended frame.
 */
export function startOf(plan: FramePlan, photo: number): number {
  return photo <= 0 ? 0 : outputOf(plan, photo)
}

/** The last photo of the plan (0 for an empty plan). */
export function lastPhotoOf(plan: FramePlan): number {
  return plan.totalFrames > 0 ? (plan.frameAt(plan.totalFrames - 1)?.a ?? 0) : 0
}

/** The unblended frame of `photo` (what a paused player shows). */
export function stillOf(photo: number): PlanFrame {
  return { a: photo, b: null, t: 0 }
}

/** What playback writes to the player store after a tick, or null when nothing changed. */
export function playerPatch(
  state: { readonly index: number; readonly settled: number },
  photo: number,
  settleDue: boolean,
): { index?: number; settled?: number } | null {
  const patch: { index?: number; settled?: number } = {}
  if (photo !== state.index) patch.index = photo
  if (settleDue && state.settled !== photo) patch.settled = photo
  return patch.index === undefined && patch.settled === undefined ? null : patch
}
