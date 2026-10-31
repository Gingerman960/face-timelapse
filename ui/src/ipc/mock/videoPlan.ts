// Video settings validation and timing, mirroring timelapse-video's options.rs
// and timing.rs (fps/duration coupling with JS toFixed(2), holds, crossfades),
// plus a size estimate from the quality preset.
import type { CaptionOptions, Pace, Resolution, Size, VideoQuality, VideoSettings } from '../contract'
import { invalid } from './errors'
import { RESOLUTIONS, outputSizeFor } from './geometry'
import { round } from './random'
import { type Args, num, oneOf, record } from './validate'

const FPS_RANGE = [1, 60] as const
const DURATION_RANGE = [1, 120] as const
const MAX_CROSSFADE = 30
const MAX_HOLD_SECS = 10
const BITRATE_RANGE = [100, 200_000] as const
const CAPTION_SIZE_RANGE = [0.01, 0.2] as const
const MAX_FORMAT_LEN = 64
const CAPTION_POSITIONS = ['topLeft', 'topCenter', 'topRight', 'bottomLeft', 'bottomCenter', 'bottomRight'] as const
/** chrono strftime specifiers (flags `-`, `_`, `0`, `^`, `#` allowed). */
const STRFTIME = /%[-_0^#]?[aAbBhcCdDeFgGHIjklmMnpPrRStTuUVwWxXyYzZ%+]/g

/** Bits per pixel per frame of each preset at constant QP (≈ 236 MB for 3,547 frames 1080×1440 @ 30 fps). */
const PRESET_BPP: Readonly<Record<Exclude<VideoQuality, object>, number>> = {
  low: 0.12,
  medium: 0.2,
  high: 0.34,
  max: 0.55,
}
const MP4_OVERHEAD_BYTES = 48_000

/** JavaScript's Number(x.toFixed(2)) — the legacy rounding the VIDEO crate reproduces. */
export function toFixed2(x: number): number {
  return Number(x.toFixed(2))
}

function inRange(value: number, [lo, hi]: readonly [number, number]): boolean {
  return Number.isFinite(value) && value >= lo && value <= hi
}

function parsePace(args: Args): Pace {
  const p = record(args, 'pace')
  if (p.mode === 'fps') {
    const fps = num(p, 'fps')
    if (!inRange(fps, FPS_RANGE)) throw invalid('Frame rate must be between 1 and 60 fps.')
    return { mode: 'fps', fps }
  }
  if (p.mode === 'duration') {
    const seconds = num(p, 'seconds')
    if (!inRange(seconds, DURATION_RANGE)) throw invalid('Duration must be between 1 and 120 seconds.')
    return { mode: 'duration', seconds }
  }
  throw invalid('Missing or invalid "pace".')
}

function parseQuality(args: Args): VideoQuality {
  const q = args.quality
  if (q === 'low' || q === 'medium' || q === 'high' || q === 'max') return q
  const bitrate = typeof q === 'object' && q !== null ? record(q as Args, 'bitrate') : null
  if (!bitrate) throw invalid('Missing or invalid "quality".')
  const kbps = num(bitrate, 'kbps')
  if (!Number.isInteger(kbps) || !inRange(kbps, BITRATE_RANGE)) {
    throw invalid('Bitrate must be between 100 and 200,000 kbps.')
  }
  return { bitrate: { kbps } }
}

function parseCaption(args: Args): CaptionOptions | null {
  if (args.caption === null) return null
  const c = record(args, 'caption')
  const size = num(c, 'size')
  if (!inRange(size, CAPTION_SIZE_RANGE)) throw invalid('Caption size must be between 0.01 and 0.2 of the height.')
  const format = c.format
  if (typeof format !== 'string' || format.trim() === '' || format.length > MAX_FORMAT_LEN) {
    throw invalid(`The date format must be 1–${MAX_FORMAT_LEN} characters.`)
  }
  if (format.replace(STRFTIME, '').includes('%')) throw invalid(`The date format "${format}" isn't valid.`)
  return { position: oneOf(c, 'position', CAPTION_POSITIONS), size, format }
}

/** Validates `settings` with the VIDEO crate's rules (frame-count independent part). */
export function videoSettings(args: Args): VideoSettings {
  const s = record(args, 'settings')
  const crossfade = record(s, 'crossfade')
  const frames = num(crossfade, 'frames')
  if (!Number.isInteger(frames) || frames < 0 || frames > MAX_CROSSFADE) {
    throw invalid('Crossfade must be 0–30 frames.')
  }
  const holdFirstSecs = num(s, 'holdFirstSecs')
  const holdLastSecs = num(s, 'holdLastSecs')
  if (!inRange(holdFirstSecs, [0, MAX_HOLD_SECS]) || !inRange(holdLastSecs, [0, MAX_HOLD_SECS])) {
    throw invalid('Holds must be 0–10 seconds.')
  }
  return {
    pace: parsePace(s),
    resolution: oneOf<Resolution>(s, 'resolution', RESOLUTIONS),
    quality: parseQuality(s),
    crossfade: { frames, easing: oneOf(crossfade, 'easing', ['linear', 'easeInOut']) },
    caption: parseCaption(s),
    holdFirstSecs,
    holdLastSecs,
  }
}

export interface VideoPlan {
  fps: number
  framesTotal: number
  durationSecs: number
  size: Size
  bytes: number
}

/**
 * Resolves fps, total frames (content + holds), output size and an estimated
 * file size for `sourceFrames` frames whose masters are `masterSize`.
 * Throws `invalidArgument` for an infeasible pace or a size above the masters.
 */
export function planVideo(settings: VideoSettings, sourceFrames: number, masterSize: Size): VideoPlan {
  const content = sourceFrames + Math.max(0, sourceFrames - 1) * settings.crossfade.frames
  const holds = settings.holdFirstSecs + settings.holdLastSecs
  let fps: number
  if (settings.pace.mode === 'fps') {
    fps = toFixed2(settings.pace.fps)
  } else {
    const contentSecs = settings.pace.seconds - holds
    if (contentSecs <= 0) {
      throw invalid(`A ${settings.pace.seconds} s video can't fit ${round(holds, 1)} s of first/last holds.`)
    }
    fps = toFixed2(content / contentSecs)
  }
  if (fps < FPS_RANGE[0] || fps > FPS_RANGE[1]) {
    const lo = Math.max(DURATION_RANGE[0], content / FPS_RANGE[1] + holds)
    const hi = Math.min(DURATION_RANGE[1], content / FPS_RANGE[0] + holds)
    const range = lo <= hi ? ` Choose a duration between ${lo.toFixed(1)} s and ${hi.toFixed(1)} s.` : ''
    throw invalid(`${sourceFrames} photos at this duration need ${fps} fps, outside 1–60 fps.${range}`)
  }
  const size =
    settings.resolution === 'source'
      ? masterSize
      : (outputSizeFor(settings.resolution, masterSize.width, masterSize.height) ?? masterSize)
  if (size.width > masterSize.width || size.height > masterSize.height) {
    throw invalid(
      `Frames were aligned at ${masterSize.width} × ${masterSize.height}. Choose that size or smaller, or align again at a larger size.`,
    )
  }
  const framesTotal = content + Math.round(settings.holdFirstSecs * fps) + Math.round(settings.holdLastSecs * fps)
  const durationSecs = round(framesTotal / fps, 3)
  const q = settings.quality
  const bytes =
    typeof q === 'object'
      ? Math.round((q.bitrate.kbps * 1000 * durationSecs) / 8) + MP4_OVERHEAD_BYTES
      : Math.round((PRESET_BPP[q] * size.width * size.height * framesTotal) / 8) + MP4_OVERHEAD_BYTES
  return { fps, framesTotal, durationSecs, size, bytes }
}
