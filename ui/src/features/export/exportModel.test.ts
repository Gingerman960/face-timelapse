import { describe, expect, it } from 'vitest'
import type { ImageExportSettings, VideoSettings } from '../../ipc/contract'
import { crossfadePlan } from '../../lib/video'
import {
  captionStyle,
  clashHelp,
  crossfadeOptions,
  encodingDataGroups,
  encodingDay,
  encodingHeading,
  exportSubtitle,
  videoLengthGroups,
  formatDurationField,
  frameFileExtension,
  framesSummary,
  parseDuration,
  parseHoldSecs,
  parseJpegQuality,
  qualityChoice,
  planExport,
  qualityOptions,
  resolutionChoices,
  shownResolution,
  sizeHelp,
  summaryText,
  videoSummaryGroups,
  framesSummaryGroups,
  visibleResolutions,
  suggestedVideoName,
  blendHelp,
  moreOptionsSummary,
  paceHelp,
  videoSummary,
  videoFacts,
  framesFacts,
  factText,
  diptychSize,
  savedFacts,
  tookText,
} from './exportModel'

describe('parseDuration', () => {
  it('reads seconds, m:ss and mm:ss.d', () => {
    expect(parseDuration('118.2')).toBeCloseTo(118.2)
    expect(parseDuration('1:58.2')).toBeCloseTo(118.2)
    expect(parseDuration('01:58.2')).toBeCloseTo(118.2)
    expect(parseDuration('90s')).toBe(90)
    expect(parseDuration('1,5')).toBe(1.5)
  })
  it('rejects nonsense and non-positive values', () => {
    expect(parseDuration('abc')).toBeNull()
    expect(parseDuration('0')).toBeNull()
    expect(parseDuration('-3')).toBeNull()
  })
  it('round-trips through the field format', () => {
    expect(formatDurationField(118.2)).toBe('1:58.2')
    expect(formatDurationField(5)).toBe('0:05.0')
    expect(parseDuration(formatDurationField(354.7))).toBeCloseTo(354.7)
  })
})

describe('resolutionChoices', () => {
  it('blocks presets larger than the aligned masters', () => {
    const c = resolutionChoices({ width: 1080, height: 1440 }, '1080p')
    const by = Object.fromEntries(c.map((x) => [x.value, x]))
    expect(by['720p']?.blocked).toBeNull()
    expect(by['720p']?.size).toEqual({ width: 720, height: 960 })
    expect(by['1080p']?.blocked).toBeNull()
    expect(by['2160p']?.blocked).toBe('Larger than your frames, which were aligned at 1080p. Align again at 4K to export 4K.')
    expect(by.source?.size).toEqual({ width: 1080, height: 1440 })
    expect(by.source?.blocked).toBeNull()
  })
  it('blocks everything before alignment', () => {
    expect(resolutionChoices(null, '1080p').every((c) => c.blocked !== null)).toBe(true)
  })

  // P2-13: 1080p and Source gave the same 1080 × 1440 output side by side.
  it('hides a size that gives the same output as an earlier one, and shows its twin as chosen', () => {
    const c = resolutionChoices({ width: 1080, height: 1440 }, '1080p')
    expect(visibleResolutions(c).map((x) => x.value)).toEqual(['720p', '1080p', '2160p'])
    expect(shownResolution('source', c)).toBe('1080p')
    expect(shownResolution('720p', c)).toBe('720p')
    // Frames aligned at their own odd size keep Source.
    const own = resolutionChoices({ width: 1664, height: 2218 }, 'source')
    expect(visibleResolutions(own).map((x) => x.value)).toEqual(['720p', '1080p', '2160p', 'source'])
    expect(shownResolution('source', own)).toBe('source')
  })

  it('says under the sizes which ones are larger than the frames', () => {
    const c = resolutionChoices({ width: 1080, height: 1440 }, '1080p')
    expect(sizeHelp({ width: 1080, height: 1440 }, c)).toBe('1080 × 1440 px. 4K is larger than your frames.')
    expect(sizeHelp({ width: 720, height: 960 }, resolutionChoices({ width: 3840, height: 2160 }, '2160p'))).toBe('720 × 960 px. Exports are never larger than the aligned frames.')
    expect(sizeHelp(null, resolutionChoices(null, '1080p'))).toBe('Align the days first.')
  })
})

describe('captionStyle', () => {
  it('places the caption by corner and scales it with the preview', () => {
    expect(captionStyle('bottomLeft', 0.04, 250)).toMatchObject({ fontSize: 10, bottom: 8, left: 8 })
    expect(captionStyle('topRight', 0.05, 400)).toMatchObject({ top: 16, right: 16 })
    expect(captionStyle('topCenter', 0.01, 100)).toMatchObject({ fontSize: 8, left: '50%' })
  })
})

describe('suggestedVideoName', () => {
  it('names the file after the years covered', () => {
    expect(suggestedVideoName('2012-09-01', '2022-08-31')).toBe('FaceTimelapse 2012–2022.mp4')
    expect(suggestedVideoName('2014-01-01', '2014-12-31')).toBe('FaceTimelapse 2014.mp4')
    expect(suggestedVideoName(null, null)).toBe('FaceTimelapse.mp4')
  })
})

describe('paceHelp (one pace in days a second, QA N4)', () => {
  const range = { min: 60, max: 120 }
  const at = (fps: number, durationSecs: number, blend = 0) => ({ fps, durationSecs, daysPerSecond: fps / (1 + blend) })

  it('flags a pace past what the encoder takes first, in days a second for the blend', () => {
    expect(paceHelp('duration', at(61, 59), 0, range)).toEqual({ text: 'Pick between 1 and 60 days a second.', invalid: 'pace' })
    expect(paceHelp('fps', at(90, 100, 2), 2, range)).toEqual({ text: 'With Blend 2, pick between 0.33 and 20 days a second.', invalid: 'pace' })
    expect(paceHelp('fps', at(0, 0), 0, null).invalid).toBe('pace')
  })

  // Regression (M14): a pace that runs past 2:00 is valid; its length is information.
  it('reports the length of a long pace without flagging it', () => {
    expect(paceHelp('fps', at(10, 355.7), 0, range)).toEqual({ text: 'At 10 days/s the video runs 5:55.7.', invalid: null })
    expect(paceHelp('fps', at(29.97, 400, 2), 2, null)).toEqual({ text: 'At 9.99 days/s the video runs 6:40.0.', invalid: null })
  })

  it('flags a typed length outside the feasible range', () => {
    expect(paceHelp('duration', at(20, 180), 0, range)).toEqual({ text: 'With these settings the video can last 1:00.0 to 2:00.0.', invalid: 'duration' })
  })

  it('explains the coupling when everything fits', () => {
    expect(paceHelp('fps', at(30, 119.2), 0, range)).toEqual({ text: 'Change one and the other follows, so every day stays on screen equally long.', invalid: null })
    expect(paceHelp('duration', at(30, 120.004), 0, range).invalid).toBeNull()
  })
})

describe('blendHelp: the output frame rate lives only in the export sheet', () => {
  // Critique round 5, P1-7: in the sheet a count of "frames" is always video frames; days are days.
  it('names the video frames between days and the frame rate they make', () => {
    expect(blendHelp(0, 10)).toBe('Each day is one video frame: the video runs at 10 fps.')
    expect(blendHelp(2, 30)).toBe('2 video frames fade each day into the next: the video runs at 30 fps.')
    expect(blendHelp(4, 29.99)).toBe('4 video frames fade each day into the next: the video runs at 29.99 fps.')
  })
})

describe('moreOptionsSummary: folded settings stay visible by value', () => {
  const video: VideoSettings = {
    pace: { mode: 'fps', fps: 30 },
    resolution: '1080p',
    quality: 'high',
    crossfade: { frames: 2, easing: 'easeInOut' },
    caption: null,
    holdFirstSecs: 0,
    holdLastSecs: 1,
  }

  it('names the blend, the holds and the quality', () => {
    expect(moreOptionsSummary(video)).toBe('Blend 2 · Hold last 1 s · High quality')
    expect(moreOptionsSummary({ ...video, crossfade: { frames: 0, easing: 'linear' }, holdFirstSecs: 2, quality: 'low' })).toBe('Cut · Hold first 2 s and last 1 s · Small quality')
    expect(moreOptionsSummary({ ...video, holdLastSecs: 0, quality: { bitrate: { kbps: 8000 } } })).toBe('Blend 2 · No holds · 8,000 kbps')
  })
})

describe('choices that show the value in effect (L3)', () => {
  it('adds a custom blend length as its own option, in order', () => {
    expect(crossfadeOptions(4, 5).map((o) => o.label)).toEqual(['Cut', 'Blend 2', 'Blend 4', 'Blend 8'])
    expect(crossfadeOptions(3, 5).map((o) => [o.value, o.label])).toEqual([['0', 'Cut'], ['2', 'Blend 2'], ['3', 'Blend 3'], ['4', 'Blend 4'], ['8', 'Blend 8']])
  })

  it('disables a blend that would need more than 60 fps at the pace, with the reason', () => {
    const options = crossfadeOptions(2, 10)
    expect(options.filter((o) => o.disabled).map((o) => o.label)).toEqual(['Blend 8'])
    expect(options.find((o) => o.label === 'Blend 8')?.title).toBe('At 10 days/s, Blend 8 would need 90 fps (60 at most).')
    expect(crossfadeOptions(8, 10).find((o) => o.label === 'Blend 8')?.disabled).toBe(false)
  })

  it('shows a custom bitrate as itself instead of pretending it is High', () => {
    expect(qualityChoice('max')).toBe('max')
    expect(qualityChoice({ bitrate: { kbps: 8000 } })).toBe('custom')
    expect(qualityOptions('high').map((o) => o.value)).toEqual(['low', 'medium', 'high', 'max'])
    expect(qualityOptions({ bitrate: { kbps: 8000 } }).at(-1)).toEqual({ value: 'custom', label: '8,000 kbps' })
  })
})

describe('summary lines', () => {
  const settings: VideoSettings = {
    pace: { mode: 'fps', fps: 30 },
    resolution: '1080p',
    quality: 'high',
    crossfade: { frames: 0, easing: 'easeInOut' },
    caption: null,
    holdFirstSecs: 0,
    holdLastSecs: 1,
  }
  const timing = { fps: 30, durationSecs: 119.23, totalFrames: 3577, feasible: true }

  it('describes the video, with the video length in the same m:ss.d as the duration field', () => {
    expect(videoSummary({ width: 1080, height: 1440 }, timing, settings, 236e6)).toBe('H.264 · 1080 × 1440 · 30 fps · 1:59.2 with holds · ≈ 236 MB')
    expect(videoSummary({ width: 720, height: 960 }, timing, { ...settings, holdLastSecs: 0 }, null)).toBe('H.264 · 720 × 960 · 30 fps · 1:59.2')
  })

  // P2-13: only the values are in the data font.
  it('marks the values, not the words, for the data font', () => {
    const groups = videoSummaryGroups({ width: 1080, height: 1440 }, timing, settings, 236e6)
    const values = groups.flat().filter((p) => p.value).map((p) => p.text)
    expect(values).toEqual(['1080 × 1440', '30', '1:59.2', '236'])
    expect(summaryText(groups)).toBe('H.264 · 1080 × 1440 · 30 fps · 1:59.2 with holds · ≈ 236 MB')
    const frames = framesSummaryGroups(3547, 'png', { width: 1080, height: 1440 })
    expect(frames.flat().filter((p) => p.value).map((p) => p.text)).toEqual(['3,547', '1080 × 1440'])
    expect(summaryText(frames)).toBe('3,547 PNG files · 1080 × 1440')
  })

  it('describes the frames', () => {
    expect(framesSummary(3547, 'png', { width: 1080, height: 1440 })).toBe('3,547 PNG files · 1080 × 1440')
    expect(framesSummary(2, 'jpeg', null)).toBe('2 JPEG files')
  })

  // QA 5: counts read correctly at 1.
  it('says "1 PNG file", not "1 PNG files"', () => {
    expect(framesSummary(1, 'png', null)).toBe('1 PNG file')
  })
})

// Critique round 5, P1-7: "Encoding 39 of 10,777 frames" sat under "3,573 frames". The sheet
// counts days; the encoder's frames are named "video frames" and only on the data line.
describe('encoding counts in days', () => {
  // The QA export: 3,573 days, Blend 2 and a 1 s last hold at 60 fps make 10,777 video frames.
  const plan = crossfadePlan(3573, 2, 'easeInOut', { first: 0, last: 60 })

  it('names the day of the video frame being written, holds and blends included', () => {
    expect(plan.totalFrames).toBe(10_777)
    expect(encodingDay(0, 10_777, plan, 3573)).toBe(1)
    // Frame 38 blends day 13 into day 14; frame 39 is day 14 itself.
    expect(encodingDay(38, 10_777, plan, 3573)).toBe(13)
    expect(encodingDay(39, 10_777, plan, 3573)).toBe(14)
    expect(encodingDay(10_716, 10_777, plan, 3573)).toBe(3573)
    expect(encodingDay(10_750, 10_777, plan, 3573)).toBe(3573)
    expect(encodingDay(10_777, 10_777, plan, 3573)).toBe(3573)
  })

  it('without a plan for the job (image files, or another total) maps the share done onto the days', () => {
    expect(encodingDay(0, 3573, null, 3573)).toBe(1)
    expect(encodingDay(13, 3573, null, 3573)).toBe(14)
    expect(encodingDay(3573, 3573, null, 3573)).toBe(3573)
    expect(encodingDay(5000, 10_000, plan, 3573)).toBe(1787)
    expect(encodingDay(5, 0, null, 11)).toBe(1)
    expect(encodingDay(5, 10, null, 0)).toBe(0)
  })

  it('heads the progress with the day: "Encoding day 14 of 3,573"', () => {
    expect(encodingHeading('video', 14, 3573)).toBe('Encoding day 14 of 3,573')
    expect(encodingHeading('frames', 1, 1)).toBe('Saving day 1 of 1')
  })

  // Critique round 6, P2-7: "3,577 video frames" beside 3,547 days read as a typo; the line gives the video's length.
  it('the data line gives the video being written by its length and rate, then the time left; only the values are data', () => {
    const line = encodingDataGroups(videoLengthGroups(179.6, 60), 12_000)
    expect(summaryText(line)).toBe('2:59.6 of video · 60 fps · about 12 s left')
    expect(line.flat().filter((p) => p.value).map((p) => p.text)).toEqual(['2:59.6', '60'])
    expect(summaryText(encodingDataGroups(videoLengthGroups(null, null), null))).toBe('estimating…')
    const files = framesSummaryGroups(3573, 'png', { width: 1080, height: 1440 })
    expect(summaryText(encodingDataGroups(files, 12_000))).toBe('3,573 PNG files · 1080 × 1440 · about 12 s left')
  })

  it('the sheet’s subtitle counts days too', () => {
    expect(exportSubtitle(3573, '2012-09-01', '2022-08-31')).toBe('3,573 days · 1 Sep 2012 – 31 Aug 2022')
    expect(exportSubtitle(1, '2014-08-14', '2014-08-14')).toBe('1 day · 14 Aug 2014')
    expect(exportSubtitle(3547, null, null)).toBe('3,547 days')
  })
})

describe('parseHoldSecs and parseJpegQuality', () => {
  it('accept values in range and reject the rest', () => {
    expect(parseHoldSecs('1,5')).toBe(1.5)
    expect(parseHoldSecs('0')).toBe(0)
    expect(parseHoldSecs('11')).toBeNull()
    expect(parseHoldSecs('x')).toBeNull()
    expect(parseJpegQuality('80.4')).toBe(80)
    expect(parseJpegQuality('20')).toBeNull()
    expect(parseJpegQuality('much')).toBeNull()
  })
})

// QA 24: the frames export showed ".png" help for JPEG and the video's size on the preview.
describe('frames export copy and size', () => {
  const video: VideoSettings = {
    pace: { mode: 'fps', fps: 30 },
    resolution: '720p',
    quality: 'high',
    crossfade: { frames: 0, easing: 'easeInOut' },
    caption: null,
    holdFirstSecs: 0,
    holdLastSecs: 1,
  }
  const images: ImageExportSettings = { format: 'jpeg', jpegQuality: 95, overwrite: false }
  const master = { width: 1080, height: 1440 }

  it('names files with the extension the backend writes', () => {
    expect(frameFileExtension('png')).toBe('png')
    expect(frameFileExtension('jpeg')).toBe('jpg')
  })

  it('the clash help shows the chosen format’s extension', () => {
    expect(clashHelp('png')).toBe('Off: a clash becomes 20140814_1.png, never overwritten')
    expect(clashHelp('jpeg')).toBe('Off: a clash becomes 20140814_1.jpg, never overwritten')
  })

  it('the size is what the export writes: the video’s size, or the aligned frames’ own size', () => {
    expect(planExport('video', 3547, video, images, master, '1080p', 'off').size).toEqual({ width: 720, height: 960 })
    expect(planExport('frames', 3547, video, images, master, '1080p', 'off').size).toEqual(master)
    expect(planExport('frames', 3547, video, images, null, '1080p', 'off').size).toBeNull()
  })
})

// Critique round 4, item 25: the footer's spec moved into the preview column as facts.
describe('export facts', () => {
  const settings: VideoSettings = {
    pace: { mode: 'fps', fps: 30 },
    resolution: '1080p',
    quality: 'high',
    crossfade: { frames: 0, easing: 'easeInOut' },
    caption: null,
    holdFirstSecs: 0,
    holdLastSecs: 1,
  }
  const timing = { fps: 30, durationSecs: 119.23, totalFrames: 3577, feasible: true }

  it('lists the video as label and value, the numbers marked for the data font', () => {
    const facts = videoFacts({ width: 1080, height: 1440 }, timing, settings, 324e6)
    expect(facts.map((f) => [f.label, factText(f)])).toEqual([
      ['Video', 'H.264'],
      ['Size', '1080 × 1440'],
      ['Frame rate', '30 fps'],
      ['Length', '1:59.2 with holds'],
      ['File size', '≈ 324 MB'],
    ])
    expect(facts.flatMap((f) => f.parts.filter((p) => p.value).map((p) => p.text))).toEqual(['1080 × 1440', '30', '1:59.2', '324'])
  })

  it('leaves out the holds note and the estimate when there are none', () => {
    const facts = videoFacts({ width: 720, height: 960 }, timing, { ...settings, holdLastSecs: 0 }, null)
    expect(facts.map((f) => [f.label, factText(f)])).toEqual([
      ['Video', 'H.264'],
      ['Size', '720 × 960'],
      ['Frame rate', '30 fps'],
      ['Length', '1:59.2'],
    ])
  })

  it('lists frames by count and type, then size when there are aligned frames', () => {
    expect(framesFacts(3547, 'png', { width: 1080, height: 1440 }).map((f) => [f.label, factText(f)])).toEqual([
      ['Files', '3,547 PNG'],
      ['Size', '1080 × 1440'],
    ])
    expect(framesFacts(1, 'jpeg', null).map((f) => [f.label, factText(f)])).toEqual([['Files', '1 JPEG']])
  })

  it('the plan carries the facts for the format chosen', () => {
    const images: ImageExportSettings = { format: 'png', jpegQuality: 95, overwrite: false }
    const master = { width: 1080, height: 1440 }
    expect(planExport('video', 3547, settings, images, master, '1080p', 'off').facts.map((f) => f.label)).toEqual(['Video', 'Size', 'Frame rate', 'Length', 'File size'])
    expect(planExport('frames', 3547, settings, images, master, '1080p', 'off').facts.map((f) => f.label)).toEqual(['Files', 'Size'])
  })

  // Critique round 5, P1-7: this export said ≈ 563 MB and wrote 648 MB with Even light off
  // (552 MB with it on).
  it('the file size follows the light: the QA export reads ≈ 654 MB as shot and ≈ 569 MB evened', () => {
    const images: ImageExportSettings = { format: 'png', jpegQuality: 95, overwrite: false }
    const qa: VideoSettings = { ...settings, pace: { mode: 'fps', fps: 60 }, crossfade: { frames: 2, easing: 'easeInOut' } }
    const size = (days: number, light: 'off' | 'exposureAndColor') =>
      factText(planExport('video', days, qa, images, { width: 1080, height: 1440 }, '1080p', light).facts.at(-1) ?? { label: '', parts: [] })
    expect(size(3573, 'off')).toBe('≈ 654 MB')
    expect(size(3575, 'exposureAndColor')).toBe('≈ 569 MB')
  })
})

// Critique round 5, P2-11: Saved shows the decade as a photobook spread about 220 pt tall
// (it was 158 pt on a 720 pt sheet).
describe('the saved spread', () => {
  it('prints are 220 px tall at the frames’ aspect; wide frames are narrowed to fit the sheet', () => {
    expect(diptychSize({ width: 1080, height: 1440 })).toEqual({ width: 165, height: 220 })
    expect(diptychSize({ width: 1080, height: 1080 })).toEqual({ width: 220, height: 220 })
    expect(diptychSize({ width: 1080, height: 1920 })).toEqual({ width: 124, height: 220 })
    expect(diptychSize({ width: 1920, height: 1080 })).toEqual({ width: 320, height: 180 })
    expect(diptychSize(null)).toEqual({ width: 165, height: 220 })
  })

  it('after "Saved" come the length and the size of the video, or the count of the files', () => {
    expect(savedFacts({ kind: 'video', durationSecs: 179.6, bytes: 534e6 })).toBe('2:59.6 · 534 MB')
    expect(savedFacts({ kind: 'frames', written: 10777 })).toBe('10,777 files')
    expect(savedFacts({ kind: 'frames', written: 1 })).toBe('1 file')
  })

  it('says how long it took, but not when it was under a second', () => {
    expect(tookText(567_000)).toBe('took 9 min 27 s')
    expect(tookText(1_000)).toBe('took 1 s')
    expect(tookText(5)).toBeNull()
  })
})
