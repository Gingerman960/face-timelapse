import { useMemo, useState, type ReactNode } from 'react'
import { alignedUrl } from '../../ipc/images'
import { formatShortDate } from '../../lib/dates'
import { formatCount, formatEta } from '../../lib/format'
import { Meter } from '../../components/ui/Controls'
import { DataText } from '../../components/ui/DataText'
import { ProgressAnnouncer } from '../../components/ui/ProgressAnnouncer'
import { RetryImg } from '../../components/ui/RetryImg'
import type { JobsState } from '../../state/jobs'
import { Filmstrip } from './PlayerParts'
import { alignMessage } from './timelapseModel'
import { useElementWidth } from './useElementWidth'
import { usePlayerFit, useStageFit } from './usePlayerFit'

type AlignTrack = JobsState['align']

/** The strip shows the newest frames only; copying all of a decade's on every progress tick churned memory (N3). */
const STRIP_RECENT = 64

/** Frames done and to do in the running align. */
export function alignCounts(track: AlignTrack): { done: number; total: number } {
  return { done: track.progress?.done ?? 0, total: track.progress?.total ?? track.total }
}

/** The caption block while aligning: a visual counter only; speech goes through AlignAnnouncer. */
function AligningNote({ track }: { track: AlignTrack }) {
  const { done, total } = alignCounts(track)
  return (
    <div className="aligning-note">
      <span className="row">
        <i className="indeterminate" aria-hidden="true" />
        Aligning {formatCount(done)} of {formatCount(total)}
      </span>
      <Meter value={done} max={Math.max(1, total)} label="Alignment progress" />
      <DataText>{`${Math.round(track.progress?.framesPerSecond ?? 0)} days/s · ${formatEta(track.progress?.etaMs ?? null)}`}</DataText>
      <span>Newest frames appear as they finish.</span>
    </div>
  )
}

interface AligningStageProps {
  base: string
  frameAr: string
  /** Frame width ÷ height. */
  aspect: number
  track: AlignTrack
  /** The (disabled) transport. */
  transport: ReactNode
}

/**
 * While aligning: the newest finished frame, the progress caption and frames
 * developing in on the strip (image opacity over the latent rebate tone), above
 * the disabled transport.
 */
export function AligningStage({ base, frameAr, aspect, track, transport }: AligningStageProps) {
  const { ref: frameRef, width: frameW } = useElementWidth<HTMLElement>()
  const { ref: playerRef, strip: stripFrames, axis } = usePlayerFit(aspect, frameRef)
  const { ref: stageRef } = useStageFit(aspect)
  const recent = track.recent
  const newest = recent[recent.length - 1]
  const strip = useMemo(() => recent.slice(-STRIP_RECENT).map((r) => ({ photoId: r.id, version: r.version, dayKey: r.dayKey })), [recent])
  const src = newest && frameW > 0 ? alignedUrl(base, { photoId: newest.id, version: newest.version }, frameW, window.devicePixelRatio) : null
  return (
    <div className="player" ref={playerRef} data-axis={axis['data-axis']} style={axis.style}>
      <div className="player-stage" ref={stageRef} style={{ ['--frame-ar' as string]: frameAr }}>
        <figure className="frame" ref={frameRef}>
          {newest && src ? <RetryImg src={src} alt={`Newest aligned frame, ${newest.dayKey}`} /> : null}
        </figure>
        <div className="cap-col">
          <div className="plate-caption">
            <p className="cap-date">{newest ? formatShortDate(newest.dayKey) : '—'}</p>
            <p className="cap-year">{newest?.dayKey.slice(0, 4) ?? ''}</p>
            <AligningNote track={track} />
          </div>
        </div>
      </div>
      <Filmstrip frames={strip} center={strip.length - 1} base={base} developFrom={Math.max(0, strip.length - 3)} label="Frames as they finish" count={stripFrames} />
      {transport}
    </div>
  )
}

interface AlignAnnouncerProps {
  aligning: boolean
  track: AlignTrack
  /** Frames ready once the align finished. */
  count: number
}

/**
 * Speaks align progress through one throttled live region: at the start, every
 * 10 % and when the align this screen watched finishes.
 */
export function AlignAnnouncer({ aligning, track, count }: AlignAnnouncerProps) {
  const [watched, setWatched] = useState(aligning)
  if (aligning && !watched) setWatched(true)
  const { done, total } = alignCounts(track)
  const phase = aligning ? 'running' : watched && track.summary ? 'done' : null
  const message = alignMessage(aligning, done, total, count)
  return <ProgressAnnouncer phase={phase} fraction={aligning ? done / Math.max(1, total) : null} message={message} />
}
