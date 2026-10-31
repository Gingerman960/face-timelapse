import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { VideoSettings } from '../../ipc/contract'
import { videoTiming } from '../../lib/pace'
import { MAX_FPS, MIN_FPS, framePlanFor, type FramePlan, type PlanFrame } from '../../lib/video'
import { usePlayer, type PlayerState } from '../../state/player'
import { FrameBuffer, preloadWindow, windowIndices } from './frameBuffer'
import { SETTLE_MS, advance, lastPhotoOf, photoAt, playerPatch, startOf, type Clock } from './playback'

/** Frame rate for a timeline without frames (nothing plays; the timecode reads 0). */
const IDLE_FPS = 30

/** The output timeline the player steps through, and the rate it plays at. */
export interface Playback {
  plan: FramePlan
  fps: number
}

/**
 * The export's own plan at the export's own frame rate (QA N4: one pace), so
 * the preview runs at the same days a second and lasts as long as the video.
 * A pace outside what the encoder takes still plays, clamped to 1–60 fps.
 */
export function usePlaybackPlan(count: number, video: VideoSettings): Playback {
  // Keyed on the timeline's own values: a session refetch brings an equal but new
  // settings object, which must not restart a running blend (UI review 2, L6).
  const { pace, crossfade, holdFirstSecs, holdLastSecs } = video
  const paceValue = pace.mode === 'fps' ? pace.fps : pace.seconds
  return useMemo(() => {
    const timeline = {
      pace: pace.mode === 'fps' ? { mode: 'fps' as const, fps: paceValue } : { mode: 'duration' as const, seconds: paceValue },
      crossfade: { frames: crossfade.frames, easing: crossfade.easing },
      holdFirstSecs,
      holdLastSecs,
    }
    const fps = Math.min(MAX_FPS, Math.max(MIN_FPS, videoTiming(timeline, count)?.fps ?? IDLE_FPS))
    return { plan: framePlanFor(count, timeline, fps), fps }
  }, [count, pace.mode, paceValue, crossfade.frames, crossfade.easing, holdFirstSecs, holdLastSecs])
}

/**
 * A frame buffer owned by the component. While paused, every decode (or
 * failure) re-renders the component so the frame on screen is redrawn; while
 * playing the loop draws on its own. Everything is dropped (downloads
 * cancelled) on unmount, and also while React keeps the screen hidden behind a
 * Suspense fallback (layout effects are torn down on hide, passive ones are not).
 */
export function useFrameBuffer(): FrameBuffer {
  const [, setRedraw] = useState(0)
  const [buffer] = useState(
    () =>
      new FrameBuffer(() => {
        if (!usePlayer.getState().playing) setRedraw((n) => n + 1)
      }),
  )
  useLayoutEffect(() => () => buffer.dispose(), [buffer])
  return buffer
}

/**
 * Keeps the buffer filled around the playhead, within the decoded-bytes budget
 * for frames of `frameBytes` each (HIGH-3). It follows the player store
 * directly, so moving the playhead never re-renders the canvas component. A
 * layout effect, so a screen revealed again after Suspense hid it refills.
 */
export function useFrameWindow(buffer: FrameBuffer, count: number, urlOf: (index: number) => string, extra: string | null, frameBytes: number): void {
  useLayoutEffect(() => {
    const update = ({ index, playing, rate, loop }: PlayerState) => {
      const { ahead, behind } = preloadWindow(playing, frameBytes, extra ? 1 : 0)
      const urls = windowIndices(index, count, rate < 0 ? -1 : 1, ahead, behind, playing && loop).map(urlOf)
      buffer.want(extra ? [...urls, extra] : urls)
    }
    update(usePlayer.getState())
    return usePlayer.subscribe((s, prev) => {
      const moved = s.index !== prev.index || s.playing !== prev.playing || s.loop !== prev.loop
      if (moved || Math.sign(s.rate) !== Math.sign(prev.rate)) update(s)
    })
  }, [buffer, count, urlOf, extra, frameBytes])
}

interface LoopOptions {
  plan: FramePlan
  /** Output frames per second. */
  fps: number
  /** True when the photos an output frame needs are decoded (or failed, so they are skipped). */
  canShow: (frame: PlanFrame) => boolean
  /** Paints an output frame; false when it couldn't (no size yet), so it is tried again. */
  draw: (frame: PlanFrame) => boolean
}

/**
 * While `playing`, one requestAnimationFrame loop steps the plan's clock
 * (see playback.ts), draws each output frame and mirrors the photo into the
 * player store. A seek from outside the loop (ribbon, filmstrip, ⌥←/⌥→) is
 * adopted on the next display frame instead of being overwritten.
 */
export function usePlaybackLoop(playing: boolean, { plan, fps, canShow, draw }: LoopOptions): void {
  const latest = useRef({ canShow, draw })
  // The output frame on the canvas, or -1 to paint on the next display frame.
  const drawn = useRef(-1)
  useLayoutEffect(() => {
    // A new way of drawing (onion, difference, opacity, the viewer, a resize) repaints
    // even while the output frame holds (UI review 3, L3).
    if (latest.current.draw !== draw) drawn.current = -1
    latest.current = { canShow, draw }
  })
  useEffect(() => {
    if (!playing || plan.totalFrames === 0) return
    let raf = 0
    let last = performance.now()
    let lastSettle = last
    // Play on the last photo with loop off starts the video again (UI review 2, L1).
    if (!usePlayer.getState().loop && usePlayer.getState().index >= lastPhotoOf(plan)) usePlayer.setState({ index: 0, settled: 0 })
    let written = usePlayer.getState().index
    let clock: Clock = { out: startOf(plan, written), acc: 0 }
    // A display frame that doesn't change the output frame draws nothing (UI review 2, L6).
    drawn.current = -1
    const loop = (t: number) => {
      const s = usePlayer.getState()
      if (s.index !== written) {
        written = s.index
        clock = { out: startOf(plan, written), acc: 0 }
      }
      const step = advance(clock, t - last, { plan, fps, rate: s.rate, loop: s.loop, canShow: latest.current.canShow })
      last = t
      clock = step
      const settleDue = t - lastSettle >= SETTLE_MS
      if (settleDue) lastSettle = t
      written = photoAt(plan, clock.out)
      const patch = playerPatch(s, written, settleDue)
      if (patch) usePlayer.setState(patch)
      const frame = clock.out !== drawn.current ? plan.frameAt(clock.out) : null
      if (frame && latest.current.draw(frame)) drawn.current = clock.out
      if (step.ended) usePlayer.getState().pause()
      else raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, plan, fps])
}
