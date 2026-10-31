import { useId, useState } from 'react'
import { CaretRight, LinkSimple } from '@phosphor-icons/react'
import type { Resolution, Size, VideoSettings } from '../../ipc/contract'
import { formatDaysPerSecondValue, videoTiming, withBlend, withDaysPerSecond } from '../../lib/pace'
import { feasibleDurationRange, specFromSettings } from '../../lib/video'
import { NumberField, SwitchRow } from '../../components/ui/Controls'
import { Segmented } from '../../components/ui/Segmented'
import { CaptionField } from './CaptionField'
import { VideoSaveError } from './VideoSaveError'
import {
  blendHelp,
  crossfadeOptions,
  formatDurationField,
  moreOptionsSummary,
  paceHelp,
  parseDuration,
  parseHoldSecs,
  qualityChoice,
  qualityOptions,
  resolutionChoices,
  shownResolution,
  sizeHelp,
  visibleResolutions,
  type QualityChoice,
} from './exportModel'

interface VideoFormProps {
  settings: VideoSettings
  onChange: (next: VideoSettings) => void
  count: number
  master: Size | null
  masterResolution: Resolution
  sampleDay: string
  lookOn: boolean
  onLook: (on: boolean) => void
}

interface FieldProps {
  settings: VideoSettings
  onChange: (next: VideoSettings) => void
}

/**
 * Size, a segmented control like the other choices (P2-13). A preset that gives
 * the same output as an earlier one is hidden; presets larger than the aligned
 * frames are struck through, with the reason in the tooltip and the help line.
 */
function SizeField({ settings, onChange, master, masterResolution }: FieldProps & { master: Size | null; masterResolution: Resolution }) {
  const choices = resolutionChoices(master, masterResolution)
  const shown = shownResolution(settings.resolution, choices)
  const chosen = choices.find((c) => c.value === shown)
  const options = visibleResolutions(choices).map((c) => ({
    value: c.value,
    label: c.label,
    disabled: c.blocked !== null,
    title: c.blocked ?? (c.size ? `${c.size.width} × ${c.size.height}` : undefined),
  }))
  return (
    <div className="field">
      <span className="field-label">Size</span>
      <Segmented<Resolution> label="Size" className="size-seg" value={shown} onChange={(resolution) => onChange({ ...settings, resolution })} options={options} />
      <span className="field-help">{sizeHelp(chosen?.size ?? null, choices)}</span>
    </div>
  )
}

/**
 * Coupled pace ↔ length fields, like the legacy dialog: the last one edited
 * sets the pace. The pace is in days a second, the same one the player and
 * the ledger show (QA N4); the output frame rate follows from the blend.
 */
function PaceField({ settings, onChange, count }: FieldProps & { count: number }) {
  const timing = videoTiming(settings, count)
  const blend = settings.crossfade.frames
  const fallbackFps = settings.pace.mode === 'fps' ? settings.pace.fps : 0
  const resolved = timing ?? { fps: fallbackFps, durationSecs: settings.pace.mode === 'duration' ? settings.pace.seconds : 0, daysPerSecond: fallbackFps / (1 + blend) }
  const help = paceHelp(settings.pace.mode, resolved, blend, feasibleDurationRange(specFromSettings(count, settings)))
  const setPace = (raw: string): boolean => {
    const v = Number(raw.replace(',', '.'))
    if (!Number.isFinite(v) || v <= 0) return false
    onChange(withDaysPerSecond(settings, v))
    return true
  }
  const setSecs = (raw: string): boolean => {
    const v = parseDuration(raw)
    if (v === null) return false
    onChange({ ...settings, pace: { mode: 'duration', seconds: v } })
    return true
  }
  return (
    <div className="field">
      <span className="field-label">Pace</span>
      <div className="coupled">
        <NumberField label="Days a second" value={formatDaysPerSecondValue(resolved.daysPerSecond)} unit="days/s" invalid={help.invalid === 'pace'} onCommit={setPace} />
        <LinkSimple className="icon linked-glyph" aria-hidden="true" />
        <NumberField label="Duration" value={formatDurationField(resolved.durationSecs)} unit="long" invalid={help.invalid === 'duration'} onCommit={setSecs} />
      </div>
      <span className={`field-help${help.invalid ? ' warn' : ''}`}>{help.text}</span>
    </div>
  )
}

/**
 * Cut or blend frames between days; the pace stays, the output frame rate
 * follows (named only here). A blend the pace can't take is struck through
 * like a size larger than the frames (critique round 4, item 25).
 */
function BlendField({ settings, onChange, count }: FieldProps & { count: number }) {
  const timing = videoTiming(settings, count)
  const frames = settings.crossfade.frames
  return (
    <div className="field">
      <span className="field-label">Between days</span>
      <Segmented<string>
        label="Between days"
        className="blend-seg"
        value={String(frames)}
        onChange={(v) => onChange(withBlend(settings, Number(v), count))}
        options={crossfadeOptions(frames, timing?.daysPerSecond ?? 0)}
      />
      {timing ? <span className="field-help">{blendHelp(frames, timing.fps)}</span> : null}
    </div>
  )
}

/** First and last hold, in seconds (0–10). */
function HoldField({ settings, onChange }: FieldProps) {
  const commit = (key: 'holdFirstSecs' | 'holdLastSecs') => (raw: string) => {
    const v = parseHoldSecs(raw)
    if (v === null) return false
    onChange({ ...settings, [key]: v })
  }
  return (
    <div className="field">
      <span className="field-label">Hold</span>
      <div className="holds">
        <NumberField label="Hold the first day, seconds" value={String(settings.holdFirstSecs)} unit="s first" onCommit={commit('holdFirstSecs')} />
        <NumberField label="Hold the last day, seconds" value={String(settings.holdLastSecs)} unit="s last" onCommit={commit('holdLastSecs')} />
      </div>
    </div>
  )
}

/**
 * Between days, holds and quality, folded under "More options" (critique
 * round 2: eight settings at once was too many). The toggle names their
 * current values, so nothing changes out of sight.
 */
function MoreOptions({ settings, onChange, count }: FieldProps & { count: number }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const setQuality = (quality: QualityChoice) => {
    if (quality !== 'custom') onChange({ ...settings, quality })
  }
  return (
    <div className="more-options" data-open={open || undefined}>
      <button type="button" className="more-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <CaretRight className="icon" aria-hidden="true" />
        <span>More options</span>
        <span className="more-summary">{moreOptionsSummary(settings)}</span>
      </button>
      {open ? (
        <div className="more-body" id={id}>
          <BlendField settings={settings} onChange={onChange} count={count} />
          <HoldField settings={settings} onChange={onChange} />
          <div className="field">
            <span className="field-label">Quality</span>
            <Segmented<QualityChoice> label="Quality" value={qualityChoice(settings.quality)} onChange={setQuality} options={qualityOptions(settings.quality)} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Video export settings: size, the one pace (days a second ↔ length), caption and light; the rest folds away. */
export function VideoForm({ settings, onChange, count, master, masterResolution, sampleDay, lookOn, onLook }: VideoFormProps) {
  return (
    <div className="form">
      <SizeField settings={settings} onChange={onChange} master={master} masterResolution={masterResolution} />
      <PaceField settings={settings} onChange={onChange} count={count} />
      <VideoSaveError className="in-form" />
      <CaptionField caption={settings.caption} sampleDay={sampleDay} onChange={(caption) => onChange({ ...settings, caption })} />
      <div className="field stack">
        <span className="field-label">Light</span>
        <SwitchRow label="Even out light and colour" help="Same setting as the player’s Even light" checked={lookOn} onChange={onLook} />
      </div>
      <MoreOptions settings={settings} onChange={onChange} count={count} />
    </div>
  )
}
