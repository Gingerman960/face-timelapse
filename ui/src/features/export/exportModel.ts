import type { CSSProperties } from 'react'
import type { CaptionPosition, DayKey, ImageExportSettings, ImageFormat, NormalizeMode, Pace, Resolution, Size, VideoQuality, VideoSettings } from '../../ipc/contract'
import { formatDay } from '../../lib/dates'
import { countOf, formatBytes, formatCount, formatDuration, formatEta, pluralize } from '../../lib/format'
import { blendFits, formatDaysPerSecondValue, formatPace, maxDaysPerSecond, minDaysPerSecond, type VideoTiming } from '../../lib/pace'
import {
  MAX_FPS,
  MAX_HOLD_SECS,
  estimateVideoBytes,
  outputSize,
  paceToFpsAndDuration,
  specFromSettings,
  type DurationRange,
  type FramePlan,
  type OutputSize,
  type PaceTiming,
} from '../../lib/video'
import type { SegmentOption } from '../../components/ui/Segmented'

export const RESOLUTIONS: ReadonlyArray<{ value: Resolution; label: string }> = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: '2160p', label: '4K' },
  { value: 'source', label: 'Source' },
]

export const CAPTION_SIZES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0.03, label: 'S' },
  { value: 0.04, label: 'M' },
  { value: 0.055, label: 'L' },
]

export const POSITIONS: ReadonlyArray<{ value: CaptionPosition; label: string }> = [
  { value: 'topLeft', label: 'Top left' },
  { value: 'topCenter', label: 'Top centre' },
  { value: 'topRight', label: 'Top right' },
  { value: 'bottomLeft', label: 'Bottom left' },
  { value: 'bottomCenter', label: 'Bottom centre' },
  { value: 'bottomRight', label: 'Bottom right' },
]

/**
 * Parses a duration typed as seconds ("118.2"), "m:ss(.d)" ("1:58.2") or
 * "01:58.2"; null when it is not a positive number.
 */
export function parseDuration(raw: string): number | null {
  const t = raw.trim().replace(',', '.')
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t)
  const v = m ? Number(m[1]) * 60 + Number(m[2]) : Number(t.replace(/s$/, ''))
  return Number.isFinite(v) && v > 0 ? v : null
}

/** "1:58.2" for the duration field. */
export function formatDurationField(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = secs - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** A hold typed in seconds (0–10); null when it is not one. */
export function parseHoldSecs(raw: string): number | null {
  const v = Number(raw.trim().replace(',', '.'))
  return Number.isFinite(v) && v >= 0 && v <= MAX_HOLD_SECS ? v : null
}

/** A JPEG quality typed as 50–100 (rounded); null when it is not one. */
export function parseJpegQuality(raw: string): number | null {
  const v = Math.round(Number(raw.trim()))
  return v >= 50 && v <= 100 ? v : null
}

export interface ResolutionChoice {
  value: Resolution
  label: string
  size: Size | null
  /** Why the chip is disabled (larger than the aligned masters), or null. */
  blocked: string | null
}

/** Each resolution preset's output size; presets larger than the masters are blocked (VIDEO rule). */
export function resolutionChoices(master: Size | null, masterResolution: Resolution): ResolutionChoice[] {
  return RESOLUTIONS.map(({ value, label }) => {
    if (!master) return { value, label, size: null, blocked: 'Align the days first.' }
    const out = value === 'source' ? master : outputSize(value, master.width, master.height)
    const size = out ? { width: out.width, height: out.height } : null
    const larger = size !== null && (size.width > master.width || size.height > master.height)
    const masterLabel = masterResolution === '2160p' ? '4K' : masterResolution === 'source' ? 'source size' : masterResolution
    return { value, label, size, blocked: larger ? `Larger than your frames, which were aligned at ${masterLabel}. Align again at ${label} to export ${label}.` : null }
  })
}

function sameSize(a: Size | null, b: Size | null): boolean {
  return a !== null && b !== null && a.width === b.width && a.height === b.height
}

/**
 * The sizes to offer: a preset that gives the same output as an earlier one is
 * hidden (Source when the frames were aligned at 1080p is the same 1080 × 1440
 * as 1080p). Blocked presets stay, struck through, with their reason.
 */
export function visibleResolutions(choices: readonly ResolutionChoice[]): ResolutionChoice[] {
  return choices.filter((c, i) => c.blocked !== null || !choices.slice(0, i).some((e) => e.blocked === null && sameSize(e.size, c.size)))
}

/** The offered size that gives the same output as `value`: itself, or its earlier twin when it is hidden. */
export function shownResolution(value: Resolution, choices: readonly ResolutionChoice[]): Resolution {
  const visible = visibleResolutions(choices)
  if (visible.some((c) => c.value === value)) return value
  const chosen = choices.find((c) => c.value === value)
  return visible.find((c) => c.blocked === null && sameSize(c.size, chosen?.size ?? null))?.value ?? value
}

/** The help under the sizes: the chosen size, and which presets are larger than the frames. */
export function sizeHelp(size: Size | null, choices: readonly ResolutionChoice[]): string {
  if (!size) return 'Align the days first.'
  const larger = choices.filter((c) => c.blocked !== null && c.size !== null).map((c) => c.label)
  const why = larger.length === 0 ? 'Exports are never larger than the aligned frames.' : `${larger.join(' and ')} ${larger.length === 1 ? 'is' : 'are'} larger than your frames.`
  return `${size.width} × ${size.height} px. ${why}`
}

/** Where the caption sits on the preview, scaled like the burned-in text. */
export function captionStyle(position: CaptionPosition, size: number, previewHeight: number): CSSProperties {
  const px = Math.max(8, size * previewHeight)
  const inset = Math.round(px * 0.8)
  const style: CSSProperties = { fontSize: px }
  if (position.startsWith('top')) style.top = inset
  else style.bottom = inset
  if (position.endsWith('Left')) style.left = inset
  else if (position.endsWith('Right')) style.right = inset
  else {
    style.left = '50%'
    style.transform = 'translateX(-50%)'
  }
  return style
}

/** The suggested file name: "FaceTimelapse 2012–2022.mp4". */
export function suggestedVideoName(firstDay: string | null, lastDay: string | null): string {
  if (!firstDay || !lastDay) return 'FaceTimelapse.mp4'
  const a = firstDay.slice(0, 4)
  const b = lastDay.slice(0, 4)
  return a === b ? `FaceTimelapse ${a}.mp4` : `FaceTimelapse ${a}–${b}.mp4`
}

/* ───────────────────────── Pace help (days a second ↔ length) ───────────────────────── */

/** Rounding slack when comparing a resolved duration with the feasible range. */
const RANGE_EPS = 0.005

export interface TimingHelp {
  text: string
  /** The field to flag, or null when the settings can be exported as they are. */
  invalid: 'pace' | 'duration' | null
}

/**
 * The help line under the coupled pace ↔ length fields (QA N4: the pace is in
 * days a second; the encoder's 1–60 fps limit becomes a pace range that
 * depends on the blend frames). Only a typed length is limited to the
 * feasible range (the backend checks length paces against 1–120 s); a pace
 * may run longer, so its length is information, not an error.
 */
export function paceHelp(mode: Pace['mode'], timing: Pick<VideoTiming, 'fps' | 'durationSecs' | 'daysPerSecond'>, blend: number, range: DurationRange | null): TimingHelp {
  if (!(timing.fps >= 1 && timing.fps <= MAX_FPS)) {
    const span = `pick between ${formatDaysPerSecondValue(minDaysPerSecond(blend))} and ${formatDaysPerSecondValue(maxDaysPerSecond(blend))} days a second.`
    return { text: blend > 0 ? `With Blend ${blend}, ${span}` : `${span.charAt(0).toUpperCase()}${span.slice(1)}`, invalid: 'pace' }
  }
  const secs = timing.durationSecs
  const outside = range === null || secs < range.min - RANGE_EPS || secs > range.max + RANGE_EPS
  if (mode === 'duration' && range && outside) {
    return { text: `With these settings the video can last ${formatDurationField(range.min)} to ${formatDurationField(range.max)}.`, invalid: 'duration' }
  }
  if (mode === 'fps' && outside) return { text: `At ${formatPace(timing.daysPerSecond)} the video runs ${formatDurationField(secs)}.`, invalid: null }
  return { text: 'Change one and the other follows, so every day stays on screen equally long.', invalid: null }
}

/**
 * The help under Between days: the video frames it adds and the frame rate they
 * make (the one place fps is named). In the sheet a count of frames is always
 * the video's own; the timelapse is counted in days (critique round 5, P1-7).
 */
export function blendHelp(frames: number, fps: number): string {
  const rate = `the video runs at ${Number(fps.toFixed(2))} fps.`
  return frames === 0 ? `Each day is one video frame: ${rate}` : `${frames} video frames fade each day into the next: ${rate}`
}

/* ───────────────────────── Choices that always show the value in effect ───────────────────────── */

const BLENDS = [0, 2, 4, 8]

/**
 * Cut / Blend 2 / 4 / 8, plus the session's own blend length when it is
 * another one. Changing the blend keeps the pace, so a blend that would need
 * more than 60 fps at it is disabled, with the reason (the current one stays).
 */
export function crossfadeOptions(frames: number, daysPerSecond: number): Array<SegmentOption<string>> {
  const values = BLENDS.includes(frames) ? BLENDS : [...BLENDS, frames].sort((a, b) => a - b)
  return values.map((v) => {
    const label = v === 0 ? 'Cut' : `Blend ${v}`
    const fits = v === frames || blendFits(daysPerSecond, v)
    const needs = Number((daysPerSecond * (1 + v)).toFixed(2))
    return { value: String(v), label, disabled: !fits, title: fits ? undefined : `At ${formatPace(daysPerSecond)}, ${label} would need ${needs} fps (${MAX_FPS} at most).` }
  })
}

export type QualityChoice = Exclude<VideoQuality, object> | 'custom'

const QUALITIES: ReadonlyArray<SegmentOption<QualityChoice>> = [
  { value: 'low', label: 'Small' },
  { value: 'medium', label: 'Standard' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

/** The Quality segmented value: a preset, or 'custom' for a bitrate. */
export function qualityChoice(quality: VideoQuality): QualityChoice {
  return typeof quality === 'string' ? quality : 'custom'
}

/** Quality presets, plus a "8,000 kbps" option when the settings carry a custom bitrate. */
export function qualityOptions(quality: VideoQuality): Array<SegmentOption<QualityChoice>> {
  if (typeof quality === 'string') return [...QUALITIES]
  return [...QUALITIES, { value: 'custom', label: `${formatCount(quality.bitrate.kbps)} kbps` }]
}

/** "Hold last 1 s", "Hold first 2 s and last 1 s", "No holds". */
function holdsLabel(first: number, last: number): string {
  const parts = [first > 0 ? `first ${first} s` : null, last > 0 ? `last ${last} s` : null].filter((p) => p !== null)
  return parts.length === 0 ? 'No holds' : `Hold ${parts.join(' and ')}`
}

/** The folded settings by value, on the "More options" toggle: "Blend 2 · Hold last 1 s · High quality". */
export function moreOptionsSummary(settings: VideoSettings): string {
  const frames = settings.crossfade.frames
  const blend = frames === 0 ? 'Cut' : `Blend ${frames}`
  const quality = qualityOptions(settings.quality).find((o) => o.value === qualityChoice(settings.quality))?.label ?? ''
  const qualityLabel = typeof settings.quality === 'string' ? `${String(quality)} quality` : String(quality)
  return [blend, holdsLabel(settings.holdFirstSecs, settings.holdLastSecs), qualityLabel].join(' · ')
}

/* ───────────────────────── Summary lines ───────────────────────── */

/** A run of summary text; `value` runs are set in the data font (P2-13). */
export interface SummaryPart {
  text: string
  value?: boolean
}

/** A summary line as groups joined by " · ". */
export type SummaryGroups = SummaryPart[][]

const word = (text: string): SummaryPart => ({ text })
const value = (text: string): SummaryPart => ({ text, value: true })

/** "1080 × 1440" as a value. */
function sizeGroup(size: Size): SummaryPart[] {
  return [value(`${size.width} × ${size.height}`)]
}

/** "≈ 236 MB": the words around the amount, the amount a value. */
function bytesGroup(bytes: number): SummaryPart[] {
  const [amount = '', unit = ''] = formatBytes(bytes).split(' ')
  return [word('≈ '), value(amount), word(` ${unit}`)]
}

/** The plain text of a summary line. */
export function summaryText(groups: SummaryGroups): string {
  return groups.map((g) => g.map((p) => p.text).join('')).join(' · ')
}

/** "H.264 · 1080 × 1440 · 30 fps · 1:59.2 with holds · ≈ 236 MB", values marked. */
export function videoSummaryGroups(out: OutputSize, timing: PaceTiming, settings: VideoSettings, bytes: number | null): SummaryGroups {
  const holds = settings.holdFirstSecs + settings.holdLastSecs > 0 ? [word(' with holds')] : []
  const groups: SummaryGroups = [[word('H.264')], sizeGroup(out), [value(String(timing.fps)), word(' fps')], [value(formatDurationField(timing.durationSecs)), ...holds]]
  return bytes ? [...groups, bytesGroup(bytes)] : groups
}

/** "H.264 · 1080 × 1440 · 30 fps · 1:59.2 with holds · ≈ 236 MB" (the video length as in the duration field). */
export function videoSummary(out: OutputSize, timing: PaceTiming, settings: VideoSettings, bytes: number | null): string {
  return summaryText(videoSummaryGroups(out, timing, settings, bytes))
}

/** "3,547 PNG files · 1080 × 1440" ("1 PNG file"), values marked. */
export function framesSummaryGroups(count: number, format: ImageFormat, master: Size | null): SummaryGroups {
  const files = [value(formatCount(count)), word(` ${pluralize(count, `${format.toUpperCase()} file`)}`)]
  return master ? [files, sizeGroup(master)] : [files]
}

/** "3,547 PNG files · 1080 × 1440" ("1 PNG file"). */
export function framesSummary(count: number, format: ImageFormat, master: Size | null): string {
  return summaryText(framesSummaryGroups(count, format, master))
}

/* ───────────────────────── Facts under the preview ───────────────────────── */

/**
 * One fact about the export, shown under the preview as label and value
 * (critique round 4, item 25: the footer's spec line moved into the preview
 * column, which stood empty). Values are marked for the data font.
 */
export interface ExportFact {
  label: string
  parts: SummaryPart[]
}

/** A fact's value as plain text. */
export function factText(fact: ExportFact): string {
  return fact.parts.map((p) => p.text).join('')
}

/** Video · Size · Frame rate · Length (with holds) · File size (≈, from the preset bitrate). */
export function videoFacts(out: OutputSize, timing: PaceTiming, settings: VideoSettings, bytes: number | null): ExportFact[] {
  const holds = settings.holdFirstSecs + settings.holdLastSecs > 0 ? [word(' with holds')] : []
  const facts: ExportFact[] = [
    { label: 'Video', parts: [word('H.264')] },
    { label: 'Size', parts: sizeGroup(out) },
    { label: 'Frame rate', parts: [value(String(timing.fps)), word(' fps')] },
    { label: 'Length', parts: [value(formatDurationField(timing.durationSecs)), ...holds] },
  ]
  return bytes ? [...facts, { label: 'File size', parts: bytesGroup(bytes) }] : facts
}

/** Files ("3,547 PNG") and, with aligned frames, their size. */
export function framesFacts(count: number, format: ImageFormat, master: Size | null): ExportFact[] {
  const files: ExportFact = { label: 'Files', parts: [value(formatCount(count)), word(` ${format.toUpperCase()}`)] }
  return master ? [files, { label: 'Size', parts: sizeGroup(master) }] : [files]
}

/* ───────────────────────── Saved ───────────────────────── */

/**
 * The saved spread (critique round 5, P2-11: 158 pt on a 720 pt sheet): each
 * print 220 px tall at the frames' aspect. Wide frames are narrowed so the two
 * prints, their gutter and the film's edges stay inside the sheet.
 */
const SPREAD_H = 220
const SPREAD_MAX_W = 320
const SPREAD_FALLBACK_AR = 3 / 4

/** CSS size of each print in the saved spread. */
export function diptychSize(master: Size | null): Size {
  const ar = master && master.width > 0 && master.height > 0 ? master.width / master.height : SPREAD_FALLBACK_AR
  const natural = Math.round(SPREAD_H * ar)
  return natural <= SPREAD_MAX_W ? { width: natural, height: SPREAD_H } : { width: SPREAD_MAX_W, height: Math.round(SPREAD_MAX_W / ar) }
}

export type SavedExport = { kind: 'video'; durationSecs: number; bytes: number } | { kind: 'frames'; written: number }

/** What follows "Saved": "2:59.6 · 534 MB" (the video's length and size), "3,547 files". */
export function savedFacts(saved: SavedExport): string {
  if (saved.kind === 'frames') return countOf(saved.written, 'file')
  return `${formatDurationField(saved.durationSecs)} · ${formatBytes(saved.bytes)}`
}

/** "took 9 min 27 s"; null under a second, which says nothing. */
export function tookText(ms: number): string | null {
  return ms >= 1000 ? `took ${formatDuration(ms)}` : null
}

/** The extension the backend gives exported frames: "png", or "jpg" for JPEG. */
export function frameFileExtension(format: ImageFormat): 'png' | 'jpg' {
  return format === 'png' ? 'png' : 'jpg'
}

/** Help under "Replace files with the same name", with the chosen format's extension. */
export function clashHelp(format: ImageFormat): string {
  return `Off: a clash becomes 20140814_1.${frameFileExtension(format)}, never overwritten`
}

/* ───────────────────────── Encoding, counted in days ───────────────────────── */

/**
 * The day (1-based) of the export's work in progress (critique round 5, P1-7:
 * the sheet counts days, not the encoder's frames). For a video whose plan
 * matches the job, the day of the video frame being written, holds and blends
 * included; otherwise (image files, one per day, or a total the plan doesn't
 * know) the share done mapped onto the days. 0 without days.
 */
export function encodingDay(done: number, total: number, plan: FramePlan | null, days: number): number {
  if (days <= 0) return 0
  if (total <= 0) return 1
  if (plan && plan.totalFrames === total) {
    const frame = plan.frameAt(Math.min(total - 1, Math.max(0, Math.floor(done))))
    if (frame) return Math.min(days, frame.a + 1)
  }
  return Math.min(days, Math.max(0, Math.round((done / total) * (days - 1))) + 1)
}

/** "Encoding day 14 of 3,573" ("Saving …" for image files). */
export function encodingHeading(format: ExportFormat, day: number, days: number): string {
  return `${format === 'video' ? 'Encoding' : 'Saving'} day ${formatCount(day)} of ${formatCount(days)}`
}

/**
 * "2:59.6 of video · 60 fps", values marked (critique round 6, P2-7: a count of
 * video frames beside the days read as a typo for them); nothing while the
 * length or the rate isn't known.
 */
export function videoLengthGroups(durationSecs: number | null, fps: number | null): SummaryGroups {
  if (durationSecs === null || fps === null) return []
  return [
    [value(formatDurationField(durationSecs)), word(' of video')],
    [value(String(fps)), word(' fps')],
  ]
}

/** The data line under the encoding count: what is being written, then the time left ("about 12 s left"). */
export function encodingDataGroups(lead: SummaryGroups, etaMs: number | null): SummaryGroups {
  return [...lead, [word(formatEta(etaMs).toLowerCase())]]
}

/** The sheet's subtitle, in days: "3,573 days · 1 Sep 2012 – 31 Aug 2022" ("1 day · 14 Aug 2014"). */
export function exportSubtitle(days: number, firstDay: DayKey | null, lastDay: DayKey | null): string {
  const count = countOf(days, 'day')
  if (!firstDay || !lastDay) return count
  return firstDay === lastDay ? `${count} · ${formatDay(firstDay)}` : `${count} · ${formatDay(firstDay)} – ${formatDay(lastDay)}`
}

/* ───────────────────────── The export as configured ───────────────────────── */

export type ExportFormat = 'video' | 'frames'

export interface ExportPlanSummary {
  /** The summary line with its values marked for the data font (the encoding line uses its first groups). */
  groups: SummaryGroups
  /** The export as facts under the preview. */
  facts: ExportFact[]
  /** Pixel size of what the export writes: the video's size, or the aligned frames' own size for image frames (null without aligned frames). */
  size: Size | null
  timing: PaceTiming | null
  canExport: boolean
  /** The summary line as plain text. */
  summary: string
}

/**
 * What the current settings would export, whether they can, and the footer
 * summary. `normalize` is the session look's Even light: the file size depends
 * on it (critique round 5, P1-7).
 */
export function planExport(
  format: ExportFormat,
  count: number,
  video: VideoSettings,
  images: ImageExportSettings,
  master: Size | null,
  masterResolution: Resolution,
  normalize: NormalizeMode,
): ExportPlanSummary {
  const choice = resolutionChoices(master, masterResolution).find((c) => c.value === video.resolution)
  const out = choice?.size ?? (master ? outputSize(video.resolution, master.width, master.height) : null)
  const timing = paceToFpsAndDuration(video.pace, specFromSettings(count, video))
  const canExport = count >= 2 && (format === 'frames' || (timing?.feasible ?? false)) && !choice?.blocked
  if (format !== 'video' || !out || !timing) {
    const groups = framesSummaryGroups(count, images.format, master)
    const facts = framesFacts(count, images.format, master)
    return { size: format === 'video' ? out : master, timing, canExport, groups, facts, summary: summaryText(groups) }
  }
  const bytes = estimateVideoBytes(video, out.width, out.height, count, normalize)
  const groups = videoSummaryGroups(out, timing, video, bytes)
  return { size: out, timing, canExport, groups, facts: videoFacts(out, timing, video, bytes), summary: summaryText(groups) }
}
