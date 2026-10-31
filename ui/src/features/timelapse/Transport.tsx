import { useCallback, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CaretDown, Pause, Play, SkipBack, SkipForward } from '@phosphor-icons/react'
import type { VideoSettings } from '../../ipc/contract'
import { formatPace, videoTiming } from '../../lib/pace'
import { IconButton } from '../../components/ui/Button'
import { usePlayer } from '../../state/player'
import { startOf } from './playback'
import { formatVideoLength, formatVideoTime } from './timelapseModel'
import { PacePopover } from './TransportPopovers'
import { usePlaybackPlan } from './usePlayback'

interface TransportProps {
  count: number
  disabled: boolean
  /** The video settings in effect: the timecode is video time at the export's pace. */
  video: VideoSettings
}

/**
 * Video time of the playhead and the video's length in the ledger's format
 * ("1:23 / 3:00", critique round 4 item 4); follows the ~4 Hz settled index,
 * never every frame.
 */
function Timecode({ count, video }: { count: number; video: VideoSettings }) {
  const settled = usePlayer((s) => s.settled)
  const { plan, fps } = usePlaybackPlan(count, video)
  const now = plan.totalFrames > 0 ? startOf(plan, settled) / fps : 0
  return (
    <span className="timecode mono">
      <b>{formatVideoTime(now)}</b>
      <span className="tc-total"> / {formatVideoLength(plan.totalFrames / fps)}</span>
    </span>
  )
}

function Rate({ rate }: { rate: number }) {
  if (rate === 1) return null
  return (
    <span className="rate" aria-label={`Playback rate ${rate}`}>
      {rate < 0 ? '−' : ''}
      {Math.abs(rate)}×
    </span>
  )
}

/** The pace chip's tooltip: what it sets, and the shuttle keys that change the rate. */
const PACE_TIP = 'Pace and loop (J, K, L shuttle)'

/**
 * Playback only (critique round 4, P1-2): previous, the play disc, next, the
 * timecode, the J/K/L rate and the pace (whose popover holds Loop). The Look
 * pair lives in the plate caption. Each control's tooltip carries its key
 * (critique round 5, P2-13), also as `aria-keyshortcuts`.
 */
export function Transport({ count, disabled, video }: TransportProps) {
  const { playing, rate } = usePlayer(useShallow((s) => ({ playing: s.playing, rate: s.rate })))
  const daysPerSecond = videoTiming(video, count)?.daysPerSecond ?? null
  const { toggle, step } = usePlayer.getState()
  const [paceOpen, setPaceOpen] = useState(false)
  const close = useCallback(() => setPaceOpen(false), [])
  const paceRef = useRef<HTMLButtonElement>(null)
  const playIcon = playing ? <Pause className="icon" weight="fill" aria-hidden="true" /> : <Play className="icon" weight="fill" aria-hidden="true" />
  return (
    <div className="transport" role="toolbar" aria-label="Playback" aria-disabled={disabled || undefined}>
      <IconButton label="Previous frame" title="Previous frame (←)" aria-keyshortcuts="ArrowLeft" onClick={() => step(-1, count)} disabled={disabled}>
        <SkipBack className="icon" aria-hidden="true" />
      </IconButton>
      <button
        type="button"
        className="btn-play"
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        aria-keyshortcuts="Space"
        onClick={toggle}
        disabled={disabled || count < 2}
      >
        {playIcon}
      </button>
      <IconButton label="Next frame" title="Next frame (→)" aria-keyshortcuts="ArrowRight" onClick={() => step(1, count)} disabled={disabled}>
        <SkipForward className="icon" aria-hidden="true" />
      </IconButton>
      <Timecode count={count} video={video} />
      <Rate rate={rate} />
      <span className="tsep" aria-hidden="true" />
      <button
        ref={paceRef}
        type="button"
        className="chip pace-chip"
        aria-label={daysPerSecond === null ? 'Pace' : `Pace ${formatPace(daysPerSecond)}`}
        title={PACE_TIP}
        aria-expanded={paceOpen}
        onClick={() => setPaceOpen(true)}
        disabled={disabled || daysPerSecond === null}
      >
        {daysPerSecond === null ? 'Pace' : formatPace(daysPerSecond)}
        <CaretDown className="icon" aria-hidden="true" />
      </button>
      {daysPerSecond === null ? null : <PacePopover anchor={paceRef} open={paceOpen} onClose={close} video={video} daysPerSecond={daysPerSecond} />}
    </div>
  )
}
