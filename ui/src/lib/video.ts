// ui/src/lib/video.ts
// Port of crates/timelapse-video/src/timing.rs and geometry.rs (pace coupling,
// timeline, frame plan, output size) plus a client-side file size estimate.
// Legacy rounding is JavaScript's own `Number(x.toFixed(2))`, which the Rust
// crate reproduces bit-for-bit, so it is used here directly.
import type { Easing, NormalizeMode, Pace, Resolution, VideoQuality, VideoSettings } from '../ipc/contract'

/* ───────────────────────── Constants (timing.rs / options.rs / geometry.rs) ───────────────────────── */
export const MIN_FPS = 1
export const MAX_FPS = 60
export const MIN_DURATION_SECS = 1
export const MAX_DURATION_SECS = 120
export const MAX_CROSSFADE_FRAMES = 30
export const MAX_HOLD_SECS = 10
/** Largest long side the H.264 encoder accepts. */
export const MAX_LONG_SIDE = 3840
/** Largest short side the H.264 encoder accepts. */
export const MAX_SHORT_SIDE = 2160
/** Smallest output dimension. */
export const MIN_SIDE = 16
const LEGACY_DECIMALS = 2

/* ───────────────────────── Legacy rounding and pace coupling ───────────────────────── */

/** JS `Number(x.toFixed(digits))`, the legacy UI rounding (binary ties: 1.005 → 1, 0.125 → 0.13). */
export function legacyRound(x: number, digits: number = LEGACY_DECIMALS): number {
  return Number(x.toFixed(digits))
}

/** True for finite values strictly greater than zero. */
function isPositive(x: number): boolean {
  return Number.isFinite(x) && x > 0
}

/** Shape of the output timeline (Rust `TimelineSpec`, camelCase like its serde form). */
export interface TimelineSpec {
  readonly sourceFrames: number
  readonly crossfadeFrames: number
  readonly holdFirstSecs: number
  readonly holdLastSecs: number
}

/** Repeated frames for the first and last holds. */
export interface HoldFrames {
  readonly first: number
  readonly last: number
}

/** Timeline without crossfades or holds (the legacy behaviour). */
export function plainSpec(sourceFrames: number): TimelineSpec {
  return { sourceFrames, crossfadeFrames: 0, holdFirstSecs: 0, holdLastSecs: 0 }
}

/** Timeline described by the export settings for `sourceFrames` photos (Rust `VideoOptions::timeline_spec`). */
export function specFromSettings(
  sourceFrames: number,
  settings: Pick<VideoSettings, 'crossfade' | 'holdFirstSecs' | 'holdLastSecs'>,
): TimelineSpec {
  return {
    sourceFrames,
    crossfadeFrames: settings.crossfade.frames,
    holdFirstSecs: settings.holdFirstSecs,
    holdLastSecs: settings.holdLastSecs,
  }
}

/** Normalizes a bare frame count to a plain spec. */
function toSpec(source: number | TimelineSpec): TimelineSpec {
  return typeof source === 'number' ? plainSpec(source) : source
}

/** True when the spec has at least one whole source frame. */
function hasFrames(spec: TimelineSpec): boolean {
  return Number.isInteger(spec.sourceFrames) && spec.sourceFrames > 0
}

/** Frames that carry content: every photo once plus all blend frames. */
export function contentFrames(spec: TimelineSpec): number {
  if (!hasFrames(spec)) return 0
  const blends = Math.max(0, Math.floor(spec.crossfadeFrames))
  return spec.sourceFrames + (spec.sourceFrames - 1) * blends
}

/** Rust `secs_to_frames`: round(secs × fps), 0 for non-positive inputs. */
function secsToFrames(secs: number, fps: number): number {
  return isPositive(secs) && isPositive(fps) ? Math.round(secs * fps) : 0
}

/** Repeated frames for the first and last holds at `fps`. */
export function holdFrames(spec: TimelineSpec, fps: number): HoldFrames {
  return { first: secsToFrames(spec.holdFirstSecs, fps), last: secsToFrames(spec.holdLastSecs, fps) }
}

/** Total encoded frames at `fps` (0 without source frames). */
export function totalFrames(spec: TimelineSpec, fps: number): number {
  if (!hasFrames(spec)) return 0
  const holds = holdFrames(spec, fps)
  return contentFrames(spec) + holds.first + holds.last
}

/** Non-negative part of a hold (NaN counts as 0, like Rust's f64::max). */
function nonNegative(x: number): number {
  return x > 0 ? x : 0
}

/** Seconds spent in first/last holds. */
function holdsSecs(spec: TimelineSpec): number {
  return nonNegative(spec.holdFirstSecs) + nonNegative(spec.holdLastSecs)
}

/** Duration (2-decimal legacy rounding) at `fps`; a bare count means a plain timeline (legacy coupling). */
export function durationForFps(source: number | TimelineSpec, fps: number): number | null {
  const spec = toSpec(source)
  if (!hasFrames(spec) || !isPositive(fps)) return null
  return legacyRound(totalFrames(spec, fps) / fps)
}

/** FPS (2-decimal legacy rounding) for a total duration; null when holds alone fill it. */
export function fpsForDuration(source: number | TimelineSpec, durationSecs: number): number | null {
  const spec = toSpec(source)
  if (!hasFrames(spec) || !Number.isFinite(durationSecs)) return null
  const contentSecs = durationSecs - holdsSecs(spec)
  if (!isPositive(contentSecs)) return null
  return legacyRound(contentFrames(spec) / contentSecs)
}

/** Inclusive duration range (seconds). */
export interface DurationRange {
  readonly min: number
  readonly max: number
}

/** Durations reachable within [MIN_FPS, MAX_FPS] ∩ [MIN_DURATION_SECS, MAX_DURATION_SECS]; null if empty. */
export function feasibleDurationRange(spec: TimelineSpec): DurationRange | null {
  if (!hasFrames(spec)) return null
  const content = contentFrames(spec)
  const min = Math.max(content / MAX_FPS + holdsSecs(spec), MIN_DURATION_SECS)
  const max = Math.min(content / MIN_FPS + holdsSecs(spec), MAX_DURATION_SECS)
  return min <= max ? { min, max } : null
}

/** A pace resolved against a timeline. */
export interface PaceTiming {
  /** Frame rate sent to the encoder (2-decimal legacy rounding). */
  readonly fps: number
  /** Actual video length at that fps, holds included (2-decimal legacy rounding). */
  readonly durationSecs: number
  /** Encoded frames, holds and blends included. */
  readonly totalFrames: number
  /** Whether the backend accepts this pace (fps 1–60; duration mode also 1–120 s). */
  readonly feasible: boolean
}

/** Inclusive range check that rejects NaN. */
function inRange(x: number, lo: number, hi: number): boolean {
  return Number.isFinite(x) && x >= lo && x <= hi
}

/** Resolves a `Pace` like Rust `VideoOptions::plan`; null when no fps exists (no frames, holds ≥ duration). */
export function paceToFpsAndDuration(pace: Pace, spec: TimelineSpec): PaceTiming | null {
  const fps = pace.mode === 'fps' ? legacyRound(pace.fps) : fpsForDuration(spec, pace.seconds)
  if (fps === null || !hasFrames(spec) || !isPositive(fps)) return null
  const frames = totalFrames(spec, fps)
  const feasible =
    pace.mode === 'fps'
      ? inRange(pace.fps, MIN_FPS, MAX_FPS)
      : inRange(pace.seconds, MIN_DURATION_SECS, MAX_DURATION_SECS) && inRange(fps, MIN_FPS, MAX_FPS)
  return { fps, durationSecs: legacyRound(frames / fps), totalFrames: frames, feasible }
}

/* ───────────────────────── Easing and crossfade frame plan (Timeline::frames) ───────────────────────── */

const f32 = Math.fround

/** Rust `Easing::apply` in f32: linear, or smoothstep t²(3 − 2t), input clamped to [0, 1]. */
export function applyEasing(easing: Easing, t: number): number {
  const x = f32(Math.min(1, Math.max(0, t)))
  return easing === 'linear' ? x : f32(f32(x * x) * f32(3 - f32(2 * x)))
}

/** One output frame: photo `a`, blended toward photo `b` by `t` (share of `b`); `b` null for keys/holds. */
export interface PlanFrame {
  readonly a: number
  readonly b: number | null
  readonly t: number
}

/** The resolved output timeline, addressed by output frame index. */
export interface FramePlan {
  readonly totalFrames: number
  /** What output frame `i` shows; null when `i` is outside the plan. */
  frameAt(i: number): PlanFrame | null
  /** Output index where photo `source` is shown unblended; null when out of range. */
  outputIndexOf(source: number): number | null
}

const NO_HOLDS: HoldFrames = { first: 0, last: 0 }

/** Frame plan matching the VIDEO crate: holds, then each photo followed by its blends, then the last hold. */
export function crossfadePlan(
  sourceFrames: number,
  crossfadeFrames: number,
  easing: Easing,
  holds: HoldFrames = NO_HOLDS,
): FramePlan {
  const n = Number.isInteger(sourceFrames) && sourceFrames > 0 ? sourceFrames : 0
  const c = Math.max(0, Math.floor(crossfadeFrames))
  const period = c + 1
  const first = n > 0 ? Math.max(0, Math.floor(holds.first)) : 0
  const last = n > 0 ? Math.max(0, Math.floor(holds.last)) : 0
  const content = n > 0 ? n + (n - 1) * c : 0
  const total = first + content + last
  const key = (index: number): PlanFrame => ({ a: index, b: null, t: 0 })
  return {
    totalFrames: total,
    frameAt(i: number): PlanFrame | null {
      if (!Number.isInteger(i) || i < 0 || i >= total) return null
      const j = i - first
      if (j < 0) return key(0)
      if (j >= content) return key(n - 1)
      const from = Math.floor(j / period)
      const step = j % period
      if (step === 0) return key(from)
      return { a: from, b: from + 1, t: applyEasing(easing, f32(step / period)) }
    },
    outputIndexOf(source: number): number | null {
      if (!Number.isInteger(source) || source < 0 || source >= n) return null
      return first + source * period
    },
  }
}

/** The parts of the export settings that shape the output timeline. */
export type TimelineSettings = Pick<VideoSettings, 'crossfade' | 'holdFirstSecs' | 'holdLastSecs'>

/** The plan the export would encode for `sourceFrames` photos at `fps` (the player steps through the same one). */
export function framePlanFor(sourceFrames: number, settings: TimelineSettings, fps: number): FramePlan {
  const spec = specFromSettings(sourceFrames, settings)
  return crossfadePlan(sourceFrames, spec.crossfadeFrames, settings.crossfade.easing, holdFrames(spec, fps))
}

/* ───────────────────────── Output size (geometry.rs) ───────────────────────── */

/** Pixel size of an output video or frame. */
export interface OutputSize {
  readonly width: number
  readonly height: number
}

const BOUNDING_BOXES: Readonly<Record<Exclude<Resolution, 'source'>, readonly [number, number]>> = {
  '2160p': [3840, 2160],
  '1080p': [1920, 1080],
  '720p': [1280, 720],
}

/** Rust `round_even`: nearest even integer (ties up), never below 2. */
export function roundEven(x: number): number {
  const half = Math.round(x / 2)
  return Number.isNaN(half) ? 2 : Math.max(half, 1) * 2
}

/** Largest even size with the source aspect inside the box (Rust `fit_even`). */
function fitEven(srcW: number, srcH: number, boxW: number, boxH: number): OutputSize {
  const scale = Math.min(boxW / srcW, boxH / srcH)
  const width = Math.min(roundEven(srcW * scale), Math.floor(boxW / 2) * 2)
  const height = Math.min(roundEven(srcH * scale), Math.floor(boxH / 2) * 2)
  return { width: Math.max(width, MIN_SIDE), height: Math.max(height, MIN_SIDE) }
}

/** Rust `Resolution::output_size`: preset box oriented like the source, even dims; null for empty sources. */
export function outputSize(resolution: Resolution, srcW: number, srcH: number): OutputSize | null {
  if (!isPositive(srcW) || !isPositive(srcH)) return null
  const landscape = srcW >= srcH
  const [boxLong, boxShort] =
    resolution === 'source'
      ? [Math.min(Math.max(srcW, srcH), MAX_LONG_SIDE), Math.min(Math.min(srcW, srcH), MAX_SHORT_SIDE)]
      : BOUNDING_BOXES[resolution]
  return landscape ? fitEven(srcW, srcH, boxLong, boxShort) : fitEven(srcW, srcH, boxShort, boxLong)
}

/* ───────────────────────── File size estimate ───────────────────────── */

/**
 * Constant-quality size model: bits per pixel per encoded frame, by what the
 * frame shows, times what the light costs.
 *
 * - A photo (a new day) is a scene change: nothing in the previous day predicts
 *   it, so it costs about as much as an intra frame (PHOTO_BPP_HIGH).
 * - A blend frame between two days is predicted from its neighbours and
 *   compresses well (BLEND_BPP_HIGH, about a third of a photo). So a cut costs
 *   more bits per frame than a crossfade, while a crossfade still makes the
 *   file bigger because it adds frames.
 * - A hold frame repeats the picture and codes as a near-empty P-frame
 *   (HOLD_FRAME_COST of a photo).
 * - Light as shot (Even light off) costs AS_SHOT_LIGHT_COST more than evened
 *   light: days that keep their own exposure and colour differ more from one
 *   another, so every frame carries more change (critique round 5, P1-7).
 *
 * Presets scale both with the H.264 rule of thumb that +6 QP halves the bits:
 * options.rs gives openh264 constant quantisers (low 30, medium 26, high 22,
 * max 18), and VideoToolbox's quality values are calibrated to match them
 * (encoder/videotoolbox.rs). Bits per frame do not depend on fps.
 *
 * Calibrated on four real exports (H.264 High via VideoToolbox, "high",
 * 1 s last hold, date caption), rounded so the estimate is never low:
 *   1080×1440, Blend 2, 30 fps, Even light, 3,579 days, 10,765 frames: 569.2 MB; model 569.8 MB (+0.1 %)
 *   720×960, Cut, 30 fps, Even light, 3,579 days, 3,609 frames: 146.4 MB; model 146.9 MB (+0.4 %)
 *   1080×1440, Blend 2, 60 fps, Even light, 3,575 days, 10,783 frames: 552.4 MB; model 569.2 MB (+3.0 %)
 *   1080×1440, Blend 2, 60 fps, as shot, 3,573 days, 10,777 frames: 648.1 MB; model 654.2 MB (+0.9 %)
 * (the single-rate model said 714 MB and 106 MB; the model without the light
 * term said 563 MB for both 60 fps exports, 13 % low as shot).
 * `{ bitrate }` quality is exact: kbps × duration, whatever the light.
 */
const PRESET_QP: Readonly<Record<Exclude<VideoQuality, object>, number>> = {
  low: 30,
  medium: 26,
  high: 22,
  max: 18,
}
const PHOTO_BPP_HIGH = 0.475
const BLEND_BPP_HIGH = 0.172
const QP_PER_HALVING = 6
const HOLD_FRAME_COST = 0.01
/** Light as shot against evened light: 648.1 MB against 563.8 MB modelled evened, rounded up. */
const AS_SHOT_LIGHT_COST = 1.15
const BITS_PER_BYTE = 8
const BYTES_PER_KBIT = 125

/** How much a preset scales the bits relative to "high". */
function presetScale(quality: Exclude<VideoQuality, object>): number {
  return 2 ** ((PRESET_QP.high - PRESET_QP[quality]) / QP_PER_HALVING)
}

/** Model bits per pixel of a photo frame (a new day, i.e. a scene change) for a quality preset, with evened light. */
export function bitsPerPixel(quality: Exclude<VideoQuality, object>): number {
  return PHOTO_BPP_HIGH * presetScale(quality)
}

/** Model bits per pixel of a blend frame between two days for a quality preset, with evened light. */
export function blendBitsPerPixel(quality: Exclude<VideoQuality, object>): number {
  return BLEND_BPP_HIGH * presetScale(quality)
}

/** What the frames' light costs in bits against evened light: 1 when evened (either way), more as shot. */
export function lightCost(normalize: NormalizeMode): number {
  return normalize === 'off' ? AS_SHOT_LIGHT_COST : 1
}

/**
 * Estimated MP4 size in bytes for `frameCount` days encoded at outW×outH with
 * the session's light (`normalize`, the look's Even light); null when the pace
 * has no fps.
 */
export function estimateVideoBytes(
  settings: VideoSettings,
  outW: number,
  outH: number,
  frameCount: number,
  normalize: NormalizeMode,
): number | null {
  if (!isPositive(outW) || !isPositive(outH)) return null
  const spec = specFromSettings(frameCount, settings)
  const timing = paceToFpsAndDuration(settings.pace, spec)
  if (timing === null) return null
  const { quality } = settings
  if (typeof quality === 'object') {
    return Math.round(quality.bitrate.kbps * BYTES_PER_KBIT * (timing.totalFrames / timing.fps))
  }
  const holds = holdFrames(spec, timing.fps)
  const photos = spec.sourceFrames + HOLD_FRAME_COST * (holds.first + holds.last)
  const blends = contentFrames(spec) - spec.sourceFrames
  const bitsPerPixelOfVideo = (bitsPerPixel(quality) * photos + blendBitsPerPixel(quality) * blends) * lightCost(normalize)
  return Math.round((bitsPerPixelOfVideo * outW * outH) / BITS_PER_BYTE)
}
