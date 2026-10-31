import { useRef, type CSSProperties, type ReactNode } from 'react'
import type { AlignFailure, FrameSummary, LookSettings, Point, ReferenceState, VideoSettings } from '../../ipc/contract'
import { referenceFrameUrl } from '../../ipc/images'
import { formatDay } from '../../lib/dates'
import { usePlayer, type LookMode } from '../../state/player'
import { useView } from '../../state/view'
import { vtPrintName } from '../shell/stepTransition'
import { AlignFailures } from './AlignFailures'
import { LookControls } from './LookControls'
import { PlateCaption } from './PlateCaption'
import { PlayerCanvas } from './Player'
import { PlayheadText } from './PlayheadText'
import { Filmstrip } from './PlayerParts'
import { useElementWidth } from './useElementWidth'
import { useLightsOut } from './useLightsOut'
import { useOnion } from './useOnion'
import { usePlayerFit, useStageFit } from './usePlayerFit'
import { usePlayLayout } from './usePlayLayout'

/** The burned-in date plate in the full-window viewer; the viewer dialog is described by it. */
export const VIEWER_PLATE_ID = 'viewer-plate'

/**
 * The frame's transition name, by the day it shows (critique round 5, P1-2):
 * the selected Days cell of the same day carries the same name, so a screen
 * change morphs the day into itself (base.css: data-vt-print, --vt-print).
 */
function printName(frame: FrameSummary | undefined): { 'data-vt-print'?: ''; style?: CSSProperties } {
  return frame ? { 'data-vt-print': '', style: { ['--vt-print' as string]: vtPrintName(frame.dayKey) } } : {}
}

interface PlayerStageProps {
  frames: readonly FrameSummary[]
  base: string
  frameAr: string
  /** Frame width ÷ height. */
  aspect: number
  /** The settled playhead (clamped to the frames). */
  index: number
  reference: ReferenceState | null
  referenceAnchors: Point[] | null
  video: VideoSettings
  medianResidual: number
  look: LookSettings
  /** Changes the look; a returned promise settles when the frames have the new look. */
  onLook: (look: LookSettings) => unknown
  lookMode: LookMode
  failures: readonly AlignFailure[]
  onDismissFailures: () => void
  transport: ReactNode
}

/**
 * The player, a viewer rather than an editing console (critique round 4,
 * P1-2): the canvas frame with its plate caption (facts, fit and the Look
 * pair), the filmstrip, then the playback-only transport. While playing, the
 * strip folds away and the frame takes its place (usePlayLayout), and the
 * chrome dims around the frame (lights-out, useLightsOut); in the light theme
 * the table goes dark too, under a scrim the frame, the hero date and the
 * ribbon's playhead stay above.
 */
export function PlayerStage(props: PlayerStageProps) {
  const { frames, base, frameAr, aspect, index, reference, referenceAnchors, video, medianResidual, look, onLook, lookMode, failures, onDismissFailures, transport } = props
  const { ref: frameRef, width: frameW } = useElementWidth<HTMLElement>()
  const captionRef = useRef<HTMLDivElement>(null)
  const { ref: playerRef, strip: stripFrames, printWidth, axis } = usePlayerFit(aspect, frameRef)
  const { ref: stageRef, refit } = useStageFit(aspect)
  usePlayLayout(playerRef, frameRef, captionRef, refit)
  useLightsOut(true)
  const viewer = usePlayer((s) => s.viewer)
  const playing = usePlayer((s) => s.playing)
  const anchors = useView((s) => s.anchors)
  const [onion] = useOnion()
  const frame = frames[index]
  // Images are sized for the frame while playing, paused or not, so Space never switches the image size.
  const cssWidth = Math.max(frameW, printWidth)
  const refFrame = reference && cssWidth > 0 ? referenceFrameUrl(base, reference.version, cssWidth, window.devicePixelRatio) : null
  return (
    <div className="player" ref={playerRef} data-axis={axis['data-axis']} style={axis.style}>
      {/* Lights-out in the light theme switches the table off too (critique round 5, P1-8). First,
          so the frame, the plate and the ribbon's playhead, level with it, paint over it (timelapse.css). */}
      <div className="lights-scrim" aria-hidden="true" />
      <div className="player-stage" ref={stageRef} style={{ ['--frame-ar' as string]: frameAr }}>
        <figure className={['frame', 'player-frame', viewer && 'viewer-frame'].filter(Boolean).join(' ')} ref={frameRef} {...printName(frame)}>
          <PlayerCanvas
            frames={frames}
            base={base}
            cssWidth={cssWidth}
            aspect={aspect}
            onion={onion}
            anchors={anchors}
            referenceAnchors={referenceAnchors}
            referenceFrameUrl={refFrame}
            video={video}
            label={frame ? `Frame for ${frame.dayKey}` : 'No frame'}
          />
          {/* F carries the date into the full window, burned into the print (critique round 5, P2-17). */}
          {viewer ? <PlayheadText className="frame-plate" id={VIEWER_PLATE_ID} frames={frames} format={formatDay} /> : null}
        </figure>
        <div className="cap-col" ref={captionRef}>
          <PlateCaption
            frame={frame}
            index={index}
            count={frames.length}
            frames={frames}
            medianResidual={medianResidual}
            lookOn={look.normalize !== 'off'}
            look={<LookControls disabled={frames.length === 0} look={look} onLook={onLook} lookMode={lookMode} />}
          />
          <AlignFailures failures={failures} onDismiss={onDismissFailures} onOpen={() => useView.getState().setStep('days')} />
        </div>
      </div>
      <Filmstrip frames={frames} center={index} base={base} onPick={usePlayer.getState().setIndex} label="Frames near the playhead" count={stripFrames} frozen={playing} />
      {transport}
    </div>
  )
}
