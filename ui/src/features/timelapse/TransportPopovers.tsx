import type { RefObject } from 'react'
import type { LookSettings, VideoSettings } from '../../ipc/contract'
import { blendFits, formatDaysPerSecondValue, withDaysPerSecond } from '../../lib/pace'
import { SwitchRow } from '../../components/ui/Controls'
import { Popover } from '../../components/ui/Overlays'
import { Segmented, type SegmentOption } from '../../components/ui/Segmented'
import { usePlayer, type LookMode } from '../../state/player'
import { setVideoSettings } from '../../state/video'
import type { OnionSettings } from './Player'
import { useRangeDraft } from './useRangeDraft'
import { VideoSaveError } from '../export/VideoSaveError'

/** Paces offered, in days a second. */
const PACES = [5, 10, 15, 20, 30]

/**
 * Pace choices in days a second; a pace that isn't a preset (a length pace
 * resolves to e.g. 9.85) shows as its own option, so one is always checked.
 * A pace the blend frames would push past 60 fps is offered but disabled.
 */
export function paceOptions(daysPerSecond: number, blendFrames: number): Array<SegmentOption<string>> {
  const current = Number(formatDaysPerSecondValue(daysPerSecond))
  const values = PACES.includes(current) ? PACES : [...PACES, current].sort((a, b) => a - b)
  return values.map((v) => {
    const fits = v === current || blendFits(v, blendFrames)
    return { value: String(v), label: String(v), disabled: !fits, title: fits ? undefined : `Too fast with Blend ${blendFrames}: the video would need more than 60 frames a second.` }
  })
}

interface PopoverBase {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
}

interface PacePopoverProps extends PopoverBase {
  video: VideoSettings
  daysPerSecond: number
}

/**
 * The one pace (QA N4): days a second, shared with the ledger and the export.
 * Loop lives here too (critique round 4, P1-2: the transport plays, nothing else).
 */
export function PacePopover({ anchor, open, onClose, video, daysPerSecond }: PacePopoverProps) {
  const loop = usePlayer((s) => s.loop)
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} labelledBy="pace-title" placement="above-center" width={300}>
      <h3 id="pace-title">Pace</h3>
      <Segmented<string>
        label="Days a second"
        value={formatDaysPerSecondValue(daysPerSecond)}
        onChange={(v) => setVideoSettings(withDaysPerSecond(video, Number(v)))}
        options={paceOptions(daysPerSecond, video.crossfade.frames)}
      />
      <p>Days a second, here and in the exported video.</p>
      <VideoSaveError />
      <SwitchRow label="Loop" help="Plays again from the first day" checked={loop} onChange={usePlayer.getState().setLoop} />
    </Popover>
  )
}

const ONION_SOURCES: ReadonlyArray<SegmentOption<OnionSettings['source']>> = [
  { value: 'previous', label: 'Previous day' },
  { value: 'reference', label: 'Reference' },
]

interface OnionPopoverProps extends PopoverBase {
  onion: OnionSettings
  onOnion: (patch: Partial<OnionSettings>) => void
}

export function OnionPopover({ anchor, open, onClose, onion, onOnion }: OnionPopoverProps) {
  const opacity = useRangeDraft(Math.round(onion.opacity * 100), (pct) => onOnion({ opacity: pct / 100, on: true }))
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} labelledBy="onion-title" placement="above-center" width={300}>
      <h3 id="onion-title">Onion skin</h3>
      <Segmented<OnionSettings['source']> label="Compare with" value={onion.source} onChange={(source) => onOnion({ source, on: true })} options={ONION_SOURCES} />
      <label className="range-row">
        <span>Opacity</span>
        <input type="range" min={0} max={100} {...opacity} />
        <span className="mono-meta">{opacity.value}%</span>
      </label>
      <SwitchRow label="Difference" help="Shows only what moved (D)" checked={onion.difference} onChange={(difference) => onOnion({ difference, on: true })} />
    </Popover>
  )
}

const LOOK_MODES: ReadonlyArray<SegmentOption<LookMode>> = [
  { value: 'exposure', label: 'Exposure' },
  { value: 'exposureAndColor', label: 'Exposure and colour' },
]

interface LookPopoverProps extends PopoverBase {
  look: LookSettings
  onLook: (look: LookSettings) => unknown
  lookMode: LookMode
}

export function LookPopover({ anchor, open, onClose, look, onLook, lookMode }: LookPopoverProps) {
  const strength = useRangeDraft(Math.round(look.strength * 100), (pct) => onLook({ normalize: lookMode, strength: pct / 100 }))
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} labelledBy="look-title" placement="above-center" width={320}>
      <h3 id="look-title">Even out light</h3>
      <p>Matches each day’s face to the reference’s exposure{look.normalize === 'exposureAndColor' ? ' and white balance' : ''}.</p>
      <Segmented<LookMode> label="What to even out" value={lookMode} onChange={(normalize) => onLook({ ...look, normalize })} options={LOOK_MODES} />
      <label className="range-row">
        <span>Strength</span>
        <input type="range" min={0} max={100} {...strength} />
        <span className="mono-meta">{strength.value}%</span>
      </label>
    </Popover>
  )
}
