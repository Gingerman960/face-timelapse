// ui/src/lib/pace.ts
// One pace everywhere (QA N4): days a second. The ledger, the player and the
// export sheet all speak it; the output frame rate is what the encoder needs
// (days a second × the frames each day takes, itself plus its blend frames),
// and only the export sheet names it. Both live in the contract's
// `VideoSettings.pace`, so nothing new is persisted.
import type { VideoSettings } from '../ipc/contract'
import { MAX_FPS, MIN_FPS, legacyRound, paceToFpsAndDuration, specFromSettings, type PaceTiming } from './video'

/** The parts of the video settings that set the pace. */
type PaceSettings = Pick<VideoSettings, 'pace' | 'crossfade' | 'holdFirstSecs' | 'holdLastSecs'>

/** A pace resolved for a number of days: the export's timing plus the days a second. */
export interface VideoTiming extends PaceTiming {
  readonly daysPerSecond: number
}

/** Blend frames between two days (whole, never negative). */
function blendFrames(frames: number): number {
  return Math.max(0, Math.floor(frames))
}

/** Output frames each day takes: the day itself plus the blend frames after it. */
export function framesPerDay(settings: Pick<VideoSettings, 'crossfade'>): number {
  return 1 + blendFrames(settings.crossfade.frames)
}

/** The settings resolved for `days` aligned days; null without days (or when holds fill a length pace). */
export function videoTiming(settings: PaceSettings, days: number): VideoTiming | null {
  const timing = paceToFpsAndDuration(settings.pace, specFromSettings(days, settings))
  return timing ? { ...timing, daysPerSecond: timing.fps / framesPerDay(settings) } : null
}

/** The settings with the pace set in days a second (an fps pace: days a second × frames per day). */
export function withDaysPerSecond<T extends PaceSettings>(settings: T, daysPerSecond: number): T {
  return { ...settings, pace: { mode: 'fps', fps: legacyRound(daysPerSecond * framesPerDay(settings)) } }
}

/**
 * The settings with another blend length. A pace set in days a second keeps
 * its days a second (the output frame rate follows); a pace set as a length
 * keeps its length.
 */
export function withBlend<T extends PaceSettings>(settings: T, frames: number, days: number): T {
  const next: T = { ...settings, crossfade: { ...settings.crossfade, frames } }
  if (settings.pace.mode === 'duration') return next
  const timing = videoTiming(settings, days)
  return timing ? withDaysPerSecond(next, timing.daysPerSecond) : settings
}

/** Fastest pace a blend length allows: the encoder takes 60 fps at most. */
export function maxDaysPerSecond(frames: number): number {
  return MAX_FPS / (1 + blendFrames(frames))
}

/** Slowest pace a blend length allows: the encoder takes 1 fps at least. */
export function minDaysPerSecond(frames: number): number {
  return MIN_FPS / (1 + blendFrames(frames))
}

/** True when `frames` blend frames at `daysPerSecond` stay within the encoder's 60 fps. */
export function blendFits(daysPerSecond: number, frames: number): boolean {
  return daysPerSecond * (1 + blendFrames(frames)) <= MAX_FPS + 1e-9
}

/** "10", "7.5", "9.85": a pace number, two decimals at most. */
export function formatDaysPerSecondValue(daysPerSecond: number): string {
  return String(Number(daysPerSecond.toFixed(2)))
}

/** "10 days/s", "1 day/s". */
export function formatPace(daysPerSecond: number): string {
  const value = formatDaysPerSecondValue(daysPerSecond)
  return `${value} ${value === '1' ? 'day' : 'days'}/s`
}
