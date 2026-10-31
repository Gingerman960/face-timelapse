import { describe, expect, it } from 'vitest'
import type { VideoSettings } from '../ipc/contract'
import {
  blendFits,
  formatPace,
  framesPerDay,
  maxDaysPerSecond,
  minDaysPerSecond,
  videoTiming,
  withBlend,
  withDaysPerSecond,
} from './pace'

const base: VideoSettings = {
  pace: { mode: 'fps', fps: 30 },
  resolution: '1080p',
  quality: 'high',
  crossfade: { frames: 2, easing: 'easeInOut' },
  caption: null,
  holdFirstSecs: 0,
  holdLastSecs: 1,
}
const DAYS = 3578

describe('one pace: days a second', () => {
  it('reads the pace in days a second from the output frame rate and the blend frames', () => {
    // QA N4: 30 fps with Blend 2 is the same 10 days a second as 10 fps with Cut.
    expect(videoTiming(base, DAYS)).toMatchObject({ fps: 30, daysPerSecond: 10, durationSecs: 358.73 })
    const cut = { ...base, pace: { mode: 'fps', fps: 10 }, crossfade: { frames: 0, easing: 'easeInOut' } } satisfies VideoSettings
    expect(videoTiming(cut, DAYS)).toMatchObject({ fps: 10, daysPerSecond: 10, durationSecs: 358.8 })
    expect(framesPerDay(base)).toBe(3)
    expect(videoTiming(base, 0)).toBeNull()
  })

  it('a length pace resolves to its days a second', () => {
    const timing = videoTiming({ ...base, pace: { mode: 'duration', seconds: 60 } }, DAYS)
    expect(timing?.durationSecs).toBeCloseTo(60, 1)
    expect(timing?.daysPerSecond).toBeCloseTo(timing!.fps / 3, 6)
  })

  it('sets a pace in days a second as the output frame rate', () => {
    expect(withDaysPerSecond(base, 15).pace).toEqual({ mode: 'fps', fps: 45 })
    expect(withDaysPerSecond({ ...base, crossfade: { frames: 0, easing: 'linear' } }, 7.5).pace).toEqual({ mode: 'fps', fps: 7.5 })
  })

  it('changing the blend keeps the days a second (fps pace) or the length (length pace)', () => {
    expect(withBlend(base, 4, DAYS)).toMatchObject({ crossfade: { frames: 4 }, pace: { mode: 'fps', fps: 50 } })
    expect(withBlend(base, 0, DAYS).pace).toEqual({ mode: 'fps', fps: 10 })
    const byLength = { ...base, pace: { mode: 'duration', seconds: 90 } } satisfies VideoSettings
    expect(withBlend(byLength, 8, DAYS)).toMatchObject({ crossfade: { frames: 8 }, pace: { mode: 'duration', seconds: 90 } })
    expect(withBlend(base, 2, 0)).toEqual(base)
  })

  it('knows which blends fit under 60 fps at a pace, and the pace range per blend', () => {
    expect(blendFits(10, 4)).toBe(true)
    expect(blendFits(10, 8)).toBe(false)
    expect(maxDaysPerSecond(2)).toBe(20)
    expect(minDaysPerSecond(0)).toBe(1)
    expect(minDaysPerSecond(2)).toBeCloseTo(1 / 3, 6)
  })

  it('labels a pace in days a second', () => {
    expect(formatPace(10)).toBe('10 days/s')
    expect(formatPace(1)).toBe('1 day/s')
    expect(formatPace(29.56 / 3)).toBe('9.85 days/s')
  })
})
