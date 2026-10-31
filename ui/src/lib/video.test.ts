import { describe, expect, it } from 'vitest'
import type { NormalizeMode, VideoSettings } from '../ipc/contract'
import {
  MAX_DURATION_SECS,
  MIN_DURATION_SECS,
  applyEasing,
  bitsPerPixel,
  blendBitsPerPixel,
  contentFrames,
  crossfadePlan,
  durationForFps,
  estimateVideoBytes,
  feasibleDurationRange,
  fpsForDuration,
  framePlanFor,
  holdFrames,
  legacyRound,
  lightCost,
  outputSize,
  paceToFpsAndDuration,
  plainSpec,
  roundEven,
  specFromSettings,
  totalFrames,
  type TimelineSpec,
} from './video'

// Vectors from timing.rs (generated with node: Number((n / x).toFixed(2))).
const FPS_TO_DURATION: ReadonlyArray<readonly [number, number, number]> = [
  [3593, 1, 3593], [3593, 7, 513.29], [3593, 10, 359.3], [3593, 24, 149.71],
  [3593, 29.97, 119.89], [3593, 30, 119.77], [3593, 60, 59.88], [300, 7, 42.86],
  [300, 29.97, 10.01], [300, 33, 9.09], [2, 24, 0.08], [2, 29.97, 0.07], [7, 60, 0.12],
  [1000, 24, 41.67], [1000, 29.97, 33.37], [1000, 60, 16.67],
  [3547, 10, 354.7], [3547, 30, 118.23],
]
const DURATION_TO_FPS: ReadonlyArray<readonly [number, number, number]> = [
  [3593, 3, 1197.67], [3593, 13, 276.38], [3593, 59, 60.9], [3593, 60, 59.88],
  [3593, 90, 39.92], [3593, 119, 30.19], [3593, 120, 29.94], [300, 13, 23.08],
  [300, 59, 5.08], [300, 90, 3.33], [300, 119, 2.52], [2, 3, 0.67], [2, 90, 0.02],
  [7, 13, 0.54], [1000, 59, 16.95], [1000, 119, 8.4], [1000, 120, 8.33],
]

const SPEC_300: TimelineSpec = { sourceFrames: 300, crossfadeFrames: 2, holdFirstSecs: 0.5, holdLastSecs: 1.5 }

/** Builds export settings with overrides. */
function settings(overrides: Partial<VideoSettings> = {}): VideoSettings {
  return {
    pace: { mode: 'fps', fps: 30 },
    resolution: '1080p',
    quality: 'high',
    crossfade: { frames: 0, easing: 'easeInOut' },
    caption: null,
    holdFirstSecs: 0,
    holdLastSecs: 0,
    ...overrides,
  }
}

describe('legacyRound', () => {
  it('matches JavaScript toFixed including binary ties', () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [1.005, 1], [1.255, 1.25], [0.125, 0.13], [2.675, 2.67], [1.45, 1.45], [8.345, 8.35],
      [0.005, 0.01], [123.455, 123.45], [9.999, 10], [99.995, 100], [0, 0],
    ]
    for (const [x, want] of cases) expect(legacyRound(x)).toBe(want)
    expect(legacyRound(2.5, 0)).toBe(3)
    expect(legacyRound(-0.125)).toBe(-0.13)
    expect(legacyRound(Number.NaN)).toBeNaN()
    expect(legacyRound(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('legacy coupling', () => {
  it('matches the node vectors in both directions', () => {
    for (const [n, fps, want] of FPS_TO_DURATION) expect(durationForFps(n, fps)).toBe(want)
    for (const [n, secs, want] of DURATION_TO_FPS) expect(fpsForDuration(n, secs)).toBe(want)
  })

  it('returns null where the legacy UI ignored the input', () => {
    expect(durationForFps(0, 10)).toBeNull()
    expect(durationForFps(10, 0)).toBeNull()
    expect(durationForFps(10, -1)).toBeNull()
    expect(durationForFps(10, Number.NaN)).toBeNull()
    expect(durationForFps(2.5, 10)).toBeNull()
    expect(fpsForDuration(0, 10)).toBeNull()
    expect(fpsForDuration(10, 0)).toBeNull()
    expect(fpsForDuration(10, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('plain specs reduce exactly to the legacy functions', () => {
    for (const [n, fps] of FPS_TO_DURATION) expect(durationForFps(plainSpec(n), fps)).toBe(durationForFps(n, fps))
    for (const [n, s] of DURATION_TO_FPS) expect(fpsForDuration(plainSpec(n), s)).toBe(fpsForDuration(n, s))
  })
})

describe('TimelineSpec', () => {
  it('extends the duration with crossfades and holds', () => {
    expect(contentFrames(SPEC_300)).toBe(898)
    expect(holdFrames(SPEC_300, 30)).toEqual({ first: 15, last: 45 })
    expect(totalFrames(SPEC_300, 30)).toBe(958)
    expect(durationForFps(SPEC_300, 30)).toBe(31.93)
    expect(fpsForDuration(SPEC_300, 30)).toBe(32.07)
    expect(fpsForDuration(SPEC_300, 2)).toBeNull()
    expect(fpsForDuration(SPEC_300, 1)).toBeNull()
  })

  it('round-trips through the coupling', () => {
    const spec: TimelineSpec = { sourceFrames: 3593, crossfadeFrames: 1, holdFirstSecs: 0, holdLastSecs: 2 }
    const fps = fpsForDuration(spec, 120)
    expect(fps).not.toBeNull()
    const back = durationForFps(spec, fps ?? 0) ?? 0
    expect(Math.abs(back - 120)).toBeLessThan(0.05)
  })

  it('ignores negative and NaN holds and empty specs', () => {
    const spec: TimelineSpec = { sourceFrames: 10, crossfadeFrames: -3, holdFirstSecs: -1, holdLastSecs: Number.NaN }
    expect(contentFrames(spec)).toBe(10)
    expect(holdFrames(spec, 30)).toEqual({ first: 0, last: 0 })
    expect(fpsForDuration(spec, 5)).toBe(2)
    expect(holdFrames(SPEC_300, 0)).toEqual({ first: 0, last: 0 })
    expect(contentFrames(plainSpec(0))).toBe(0)
    expect(totalFrames(plainSpec(0), 30)).toBe(0)
    expect(durationForFps(plainSpec(0), 30)).toBeNull()
  })

  it('bounds feasible durations by fps and UI limits', () => {
    const range = feasibleDurationRange(plainSpec(3593))
    expect(range?.min).toBeCloseTo(3593 / 60, 9)
    expect(range?.max).toBe(MAX_DURATION_SECS)
    expect(feasibleDurationRange(plainSpec(30))).toEqual({ min: MIN_DURATION_SECS, max: 30 })
    expect(feasibleDurationRange(plainSpec(0))).toBeNull()
    expect(feasibleDurationRange(plainSpec(60 * 121))).toBeNull()
  })

  it('builds a spec from export settings', () => {
    const s = settings({ crossfade: { frames: 2, easing: 'linear' }, holdFirstSecs: 0.5, holdLastSecs: 1.5 })
    expect(specFromSettings(300, s)).toEqual(SPEC_300)
  })
})

describe('paceToFpsAndDuration', () => {
  it('resolves fps pace with legacy rounding', () => {
    expect(paceToFpsAndDuration({ mode: 'fps', fps: 30 }, SPEC_300)).toEqual({
      fps: 30, durationSecs: 31.93, totalFrames: 958, feasible: true,
    })
    expect(paceToFpsAndDuration({ mode: 'fps', fps: 10.005 }, plainSpec(3547))?.fps).toBe(10.01)
    expect(paceToFpsAndDuration({ mode: 'fps', fps: 61 }, plainSpec(10))?.feasible).toBe(false)
  })

  it('resolves duration pace like Rust plan', () => {
    const t = paceToFpsAndDuration({ mode: 'duration', seconds: 120 }, plainSpec(3593))
    expect(t).toEqual({ fps: 29.94, durationSecs: 120.01, totalFrames: 3593, feasible: true })
    expect(paceToFpsAndDuration({ mode: 'duration', seconds: 10 }, plainSpec(3593))?.feasible).toBe(false)
    expect(paceToFpsAndDuration({ mode: 'duration', seconds: 121 }, plainSpec(100))?.feasible).toBe(false)
  })

  it('returns null without a usable fps', () => {
    expect(paceToFpsAndDuration({ mode: 'duration', seconds: 2 }, SPEC_300)).toBeNull()
    expect(paceToFpsAndDuration({ mode: 'fps', fps: 30 }, plainSpec(0))).toBeNull()
    expect(paceToFpsAndDuration({ mode: 'fps', fps: 0 }, plainSpec(10))).toBeNull()
  })
})

describe('easing and crossfade plan', () => {
  it('easing curves are bounded, monotonic and symmetric', () => {
    for (const easing of ['linear', 'easeInOut'] as const) {
      expect(applyEasing(easing, 0)).toBe(0)
      expect(applyEasing(easing, 1)).toBe(1)
      expect(applyEasing(easing, -3)).toBe(0)
      let prev = 0
      for (let i = 1; i <= 100; i++) {
        const w = applyEasing(easing, i / 100)
        expect(w).toBeGreaterThanOrEqual(prev)
        prev = w
      }
    }
    expect(applyEasing('easeInOut', 0.5)).toBeCloseTo(0.5, 6)
    expect(applyEasing('easeInOut', 0.25)).toBe(Math.fround(0.15625))
  })

  it('orders holds, keys and blends like Timeline::frames', () => {
    const plan = crossfadePlan(3, 1, 'linear', { first: 2, last: 1 })
    const frames = Array.from({ length: plan.totalFrames }, (_, i) => plan.frameAt(i))
    expect(frames).toEqual([
      { a: 0, b: null, t: 0 }, { a: 0, b: null, t: 0 }, { a: 0, b: null, t: 0 },
      { a: 0, b: 1, t: 0.5 }, { a: 1, b: null, t: 0 }, { a: 1, b: 2, t: 0.5 },
      { a: 2, b: null, t: 0 }, { a: 2, b: null, t: 0 },
    ])
    expect(plan.outputIndexOf(0)).toBe(2)
    expect(plan.outputIndexOf(2)).toBe(6)
    expect(plan.outputIndexOf(3)).toBeNull()
    expect(plan.frameAt(-1)).toBeNull()
    expect(plan.frameAt(8)).toBeNull()
    expect(plan.frameAt(1.5)).toBeNull()
  })

  it('applies f32 easing weights to blends', () => {
    const plan = crossfadePlan(2, 3, 'easeInOut')
    expect(plan.totalFrames).toBe(5)
    expect(plan.frameAt(1)).toEqual({ a: 0, b: 1, t: applyEasing('easeInOut', 0.25) })
    expect(plan.frameAt(2)?.t).toBeCloseTo(0.5, 6)
    expect(plan.frameAt(4)).toEqual({ a: 1, b: null, t: 0 })
  })

  it('handles single-frame and empty timelines', () => {
    const one = crossfadePlan(1, 5, 'easeInOut')
    expect(one.totalFrames).toBe(1)
    expect(one.frameAt(0)).toEqual({ a: 0, b: null, t: 0 })
    const empty = crossfadePlan(0, 0, 'linear', { first: 3, last: 4 })
    expect(empty.totalFrames).toBe(0)
    expect(empty.frameAt(0)).toBeNull()
    expect(empty.outputIndexOf(0)).toBeNull()
  })
})

describe('framePlanFor', () => {
  it('builds the export plan from the settings, holds in frames at the given fps', () => {
    // Arrange
    const s = settings({ crossfade: { frames: 1, easing: 'linear' }, holdFirstSecs: 2 / 30, holdLastSecs: 1 / 30 })

    // Act
    const plan = framePlanFor(3, s, 30)

    // Assert: the same timeline as crossfadePlan(3, 1, linear, { first: 2, last: 1 }).
    expect(plan.totalFrames).toBe(8)
    expect(plan.frameAt(3)).toEqual({ a: 0, b: 1, t: 0.5 })
    expect(plan.outputIndexOf(0)).toBe(2)
    expect(framePlanFor(3, s, 60).totalFrames).toBe(11)
  })
})

describe('outputSize and roundEven', () => {
  it('fits presets to landscape and portrait boxes', () => {
    expect(outputSize('1080p', 4032, 3024)).toEqual({ width: 1440, height: 1080 })
    expect(outputSize('2160p', 4032, 3024)).toEqual({ width: 2880, height: 2160 })
    expect(outputSize('720p', 4032, 3024)).toEqual({ width: 960, height: 720 })
    expect(outputSize('1080p', 3840, 2160)).toEqual({ width: 1920, height: 1080 })
    expect(outputSize('1080p', 2362, 3330)).toEqual({ width: 1080, height: 1522 })
    expect(outputSize('1080p', 3440, 1440)).toEqual({ width: 1920, height: 804 })
    expect(outputSize('1080p', 1200, 1500)).toEqual({ width: 1080, height: 1350 })
    expect(outputSize('1080p', 900, 1200)).toEqual({ width: 1080, height: 1440 })
  })

  it('upscales small sources with presets', () => {
    expect(outputSize('1080p', 512, 512)).toEqual({ width: 1080, height: 1080 })
    expect(outputSize('720p', 400, 300)).toEqual({ width: 960, height: 720 })
  })

  it('keeps source size rounded to even and capped', () => {
    expect(outputSize('source', 1080, 1522)).toEqual({ width: 1080, height: 1522 })
    expect(outputSize('source', 511, 383)).toEqual({ width: 510, height: 382 })
    expect(outputSize('source', 2362, 3330)).toEqual({ width: 2160, height: 3046 })
    expect(outputSize('source', 4032, 3024)).toEqual({ width: 2880, height: 2160 })
    expect(outputSize('source', 0, 10)).toBeNull()
    expect(outputSize('1080p', 10, Number.NaN)).toBeNull()
  })

  it('always produces even sizes within encoder limits', () => {
    const sizes = [[1, 1], [3, 1000], [1000, 3], [4033, 3025], [17, 9], [5000, 5000]] as const
    for (const res of ['source', '2160p', '1080p', '720p'] as const) {
      for (const [w, h] of sizes) {
        const out = outputSize(res, w, h)
        expect(out).not.toBeNull()
        const { width, height } = out ?? { width: 0, height: 0 }
        expect(width % 2).toBe(0)
        expect(height % 2).toBe(0)
        expect(Math.min(width, height)).toBeGreaterThanOrEqual(16)
        expect(Math.max(width, height)).toBeLessThanOrEqual(3840)
        expect(Math.min(width, height)).toBeLessThanOrEqual(2160)
      }
    }
  })

  it('rounds to the nearest even number, never below 2', () => {
    expect(roundEven(0)).toBe(2)
    expect(roundEven(2.9)).toBe(2)
    expect(roundEven(3)).toBe(4)
    expect(roundEven(1079.4)).toBe(1080)
    expect(roundEven(765.9)).toBe(766)
    expect(roundEven(Number.NaN)).toBe(2)
  })
})

describe('estimateVideoBytes', () => {
  // Real exports, H.264 High via VideoToolbox, quality "high", a 1 s last hold, the date caption
  // on (QA notes 20–21 and QA-REPORT §3 and §11). Files in bytes as written.
  const PHOTOS = 3579
  const blend2 = settings({ crossfade: { frames: 2, easing: 'easeInOut' }, holdLastSecs: 1 })
  const cut = settings({ holdLastSecs: 1 })
  const encoded = (s: VideoSettings, days = PHOTOS) => paceToFpsAndDuration(s.pace, specFromSettings(days, s))
  /** Relative error of the estimate against a measured file size. */
  const error = (s: VideoSettings, w: number, h: number, actualBytes: number, light: NormalizeMode, days = PHOTOS) =>
    (estimateVideoBytes(s, w, h, days, light) ?? 0) / actualBytes - 1
  /** Honest: never below what was written, and at most 4 % above it. */
  const honest = (e: number) => {
    expect(e).toBeGreaterThanOrEqual(0)
    expect(e).toBeLessThan(0.04)
  }

  it('estimates a measured 1080p Blend 2 export at 30 fps with Even light on (569 MB, was estimated at 714 MB)', () => {
    expect(encoded(blend2)).toMatchObject({ totalFrames: 10_765, durationSecs: 358.83 })
    honest(error(blend2, 1080, 1440, 569_153_932, 'exposureAndColor'))
  })

  it('estimates a measured 720p cut export with Even light on (146 MB, was estimated at 106 MB)', () => {
    expect(encoded(cut)).toMatchObject({ totalFrames: 3609, durationSecs: 120.3 })
    honest(error(cut, 720, 960, 146_353_961, 'exposureAndColor'))
  })

  // Critique round 5, P1-7: the same export said ≈ 563 MB both ways, but evened light saved
  // 552 MB and light as shot 648 MB (13 % low): days that keep their own exposure differ more
  // from one another, so every frame costs more bits.
  const sixty = settings({
    pace: { mode: 'fps', fps: 60 },
    crossfade: { frames: 2, easing: 'easeInOut' },
    holdLastSecs: 1,
    caption: { position: 'bottomRight', size: 0.04, format: '%-d %b %Y' },
  })

  it('estimates the 60 fps Blend 2 export with Even light on (552 MB, 3,575 days)', () => {
    expect(encoded(sixty, 3575)).toMatchObject({ totalFrames: 10_783, durationSecs: 179.72 })
    honest(error(sixty, 1080, 1440, 552_387_745, 'exposureAndColor', 3575))
  })

  it('estimates the same export with Even light off (648 MB, 3,573 days; it said 563 MB)', () => {
    expect(encoded(sixty, 3573)).toMatchObject({ totalFrames: 10_777, durationSecs: 179.62 })
    honest(error(sixty, 1080, 1440, 648_068_333, 'off', 3573))
  })

  it('light as shot costs about 15 % more than evened light, whichever way it is evened', () => {
    expect(lightCost('off')).toBeCloseTo(1.15, 9)
    expect(lightCost('exposure')).toBe(1)
    expect(lightCost('exposureAndColor')).toBe(1)
    const at = (light: NormalizeMode) => estimateVideoBytes(sixty, 1080, 1440, 3573, light) ?? 0
    expect(at('off') / at('exposure')).toBeCloseTo(1.15, 6)
  })

  it('a cut costs more bits per frame than a crossfade: every day is a scene change', () => {
    const perFrame = (s: VideoSettings) => (estimateVideoBytes(s, 1080, 1440, PHOTOS, 'off') ?? 0) / (encoded(s)?.totalFrames ?? 1)
    expect(blendBitsPerPixel('high')).toBeLessThan(bitsPerPixel('high') / 2)
    expect(perFrame(cut)).toBeGreaterThan(1.5 * perFrame(blend2))
    // A blend still adds to the file: Blend 2 is bigger than the cut, smaller than three times it.
    const [c, b] = [estimateVideoBytes(cut, 1080, 1440, PHOTOS, 'off') ?? 0, estimateVideoBytes(blend2, 1080, 1440, PHOTOS, 'off') ?? 0]
    expect(b).toBeGreaterThan(c)
    expect(b).toBeLessThan(3 * c)
  })

  it('a hold adds almost nothing: its frames repeat the picture', () => {
    const noHold = estimateVideoBytes(settings(), 1080, 1440, PHOTOS, 'off') ?? 0
    const held = estimateVideoBytes(settings({ holdFirstSecs: 10, holdLastSecs: 10 }), 1080, 1440, PHOTOS, 'off') ?? 0
    expect(held / noHold - 1).toBeGreaterThan(0)
    expect(held / noHold - 1).toBeLessThan(0.01)
  })

  it('halves per +6 QP across presets', () => {
    expect(bitsPerPixel('high')).toBeCloseTo(0.475, 9)
    expect(blendBitsPerPixel('high')).toBeCloseTo(0.172, 9)
    expect(bitsPerPixel('max') / bitsPerPixel('high')).toBeCloseTo(2 ** (4 / 6), 9)
    expect(bitsPerPixel('high') / bitsPerPixel('low')).toBeCloseTo(2 ** (8 / 6), 9)
    expect(blendBitsPerPixel('max') / blendBitsPerPixel('high')).toBeCloseTo(2 ** (4 / 6), 9)
    const at = (quality: VideoSettings['quality']): number =>
      estimateVideoBytes(settings({ quality }), 1920, 1080, 100, 'off') ?? 0
    expect(at('low')).toBeLessThan(at('medium'))
    expect(at('medium')).toBeLessThan(at('high'))
    expect(at('high')).toBeLessThan(at('max'))
  })

  it('uses the exact duration for a bitrate', () => {
    const s = settings({ quality: { bitrate: { kbps: 8000 } }, holdLastSecs: 1 })
    // 300 photos + 30 hold frames at 30 fps = 11 s; 8000 kbit/s = 1 MB/s, whatever the light.
    expect(estimateVideoBytes(s, 1920, 1080, 300, 'off')).toBe(11_000_000)
    expect(estimateVideoBytes(s, 1920, 1080, 300, 'exposure')).toBe(11_000_000)
  })

  it('returns null for impossible inputs', () => {
    expect(estimateVideoBytes(settings(), 0, 1080, 100, 'off')).toBeNull()
    expect(estimateVideoBytes(settings(), 1920, 1080, 0, 'off')).toBeNull()
    const s = settings({ pace: { mode: 'duration', seconds: 1 }, holdLastSecs: 2 })
    expect(estimateVideoBytes(s, 1920, 1080, 100, 'off')).toBeNull()
  })
})
