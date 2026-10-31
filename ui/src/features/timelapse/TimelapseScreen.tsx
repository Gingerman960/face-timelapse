import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GridFour, MonitorPlay, Sidebar as SidebarIcon, Stop } from '@phosphor-icons/react'
import type { FrameSummary, LookSettings } from '../../ipc/contract'
import { formatCount } from '../../lib/format'
import { IconButton, PlateButton, QuietButton } from '../../components/ui/Button'
import { Segmented } from '../../components/ui/Segmented'
import { usePrimaryAction } from '../../hooks/useKeys'
import { reportError, requestedLook, setDayExcluded, setFrameAdjustment, setLook } from '../../state/actions'
import { cancelActiveJob, useJobs } from '../../state/jobs'
import { usePlayer } from '../../state/player'
import { useAppInfo, useFrames, useSession } from '../../state/queries'
import { useModelsBlock } from '../../state/models'
import { useVideoSettings } from '../../state/video'
import { useView, type TimelapseMode } from '../../state/view'
import { Screen } from '../shell/Screen'
import { runInViewTransition } from '../shell/stepTransition'
import { AlignAnnouncer, AligningStage, alignCounts } from './AligningStage'
import { FrameInspector } from './FrameInspector'
import { FrameSheet } from './FrameSheet'
import { useSettledIndex } from './PlayerParts'
import { PlayerStage, VIEWER_PLATE_ID } from './PlayerStage'
import { TimelapseRibbon } from './TimelapseRibbon'
import { framesSubtitle, median } from './timelapseModel'
import { Transport } from './Transport'
import { useLookMode } from './useLookMode'
import { useTimelapseKeys } from './useTimelapseKeys'
import './timelapse.css'

const DEFAULT_LOOK: LookSettings = { normalize: 'off', strength: 0.7 }

/** Lowers the full-window viewer, the frame travelling back into the player (`ft-print`). */
function closeViewer(): void {
  runInViewTransition(() => usePlayer.getState().setViewer(false))
}

/**
 * The full-window viewer's dialog: the backdrop the frame is lifted over. It
 * takes focus when it opens, so keys and VoiceOver land in it, and gives focus
 * back to where it was on close (critique round 5, P2-17). Not modal: the
 * player's keys (Space, arrows, Esc, F) keep working inside it. Described by
 * the date plate burned into the frame.
 */
function Viewer() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus({ preventScroll: true })
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  return <div ref={ref} className="viewer" role="dialog" aria-label="Full-window viewer" aria-describedby={VIEWER_PLATE_ID} tabIndex={-1} onClick={closeViewer} />
}

/**
 * Keeps the Days selection on the playhead's day each time the player settles
 * (paused, or the ~4 Hz settled index while playing), so Timelapse → Days
 * shrinks the frame into that same day's cell (critique round 5, P1-2).
 */
function useActiveDayFollowsPlayhead(day: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !day) return
    const view = useView.getState()
    if (view.activeDay !== day) view.setActiveDay(day)
  }, [day, enabled])
}

/** Opens a frame from the sheet in the player. */
function openFrame(index: number): void {
  usePlayer.getState().setIndex(index)
  useView.getState().setTimelapseMode('player')
}

function ViewSwitch({ disabled }: { disabled: boolean }) {
  const mode = useView((s) => s.timelapseMode)
  return (
    <Segmented<TimelapseMode>
      label="View"
      value={mode}
      onChange={useView.getState().setTimelapseMode}
      options={[
        { value: 'player', label: <><MonitorPlay className="icon" aria-hidden="true" />Player</>, disabled },
        { value: 'grid', label: <><GridFour className="icon" aria-hidden="true" />Sheet</>, disabled },
      ]}
    />
  )
}

interface ToolsProps {
  aligning: boolean
  busy: boolean
  canExport: boolean
  inspector: boolean
  onInspector: () => void
  onExport: () => void
}

function TimelapseTools({ aligning, busy, canExport, inspector, onInspector, onExport }: ToolsProps) {
  if (aligning) {
    return (
      <QuietButton icon={<Stop className="icon" aria-hidden="true" />} kbd="⌘." onClick={() => void cancelActiveJob()}>
        Stop
      </QuietButton>
    )
  }
  return (
    <>
      <IconButton label="Toggle frame inspector" aria-pressed={inspector} onClick={onInspector}>
        <SidebarIcon className="icon" aria-hidden="true" mirrored />
      </IconButton>
      <PlateButton kbd="E" onClick={onExport} disabled={!canExport} title={busy ? 'Another task is running.' : undefined}>
        Export…
      </PlateButton>
    </>
  )
}

function Inspector({ frame, busy }: { frame: FrameSummary; busy: boolean }) {
  // A nudge re-renders the frame through the face models (QA: models missing).
  const blocked = useModelsBlock()
  return (
    <FrameInspector
      frame={frame}
      busy={busy}
      blocked={blocked}
      onAdjust={(patch) => void setFrameAdjustment(frame.photoId, patch).catch(reportError)}
      onReplace={() => {
        useView.getState().setActiveDay(frame.dayKey)
        useView.getState().setStep('days')
      }}
      onExclude={() => void setDayExcluded(frame.dayKey, true).catch(reportError)}
    />
  )
}

/** Timelapse: play the decade, check alignment, export. Also shows the aligning state. */
export default function TimelapseScreen() {
  const session = useSession().data
  const info = useAppInfo().data
  const framesView = useFrames().data
  const aligning = useJobs((s) => s.activeKind === 'align')
  const align = useJobs((s) => s.align)
  const busy = useJobs((s) => s.activeJobId !== null)
  const mode = useView((s) => s.timelapseMode)
  const viewer = usePlayer((s) => s.viewer)
  const settled = useSettledIndex()
  // One inspector field for every screen: ⌥⌘I and the toolbar button flip the same switch (QA 25).
  const inspectorOpen = useView((s) => s.inspectorOpen)
  const [failuresOpen, setFailuresOpen] = useState(true)
  const frames = useMemo(() => framesView?.frames ?? [], [framesView])
  const count = frames.length
  const index = Math.min(settled, Math.max(0, count - 1))
  // Fewer frames (a day left out, a re-align) keep the playhead on the last one (UI review 2, H4).
  useEffect(() => {
    const s = usePlayer.getState()
    if (count > 0 && s.index >= count) s.setIndex(count - 1)
  }, [count])
  const frame = frames[index]
  useActiveDayFollowsPlayhead(frame?.dayKey, !aligning)
  const medianResidual = useMemo(() => median(frames.map((f) => f.residualPx)), [frames])
  const look = framesView?.look ?? session?.look ?? DEFAULT_LOOK
  const lookMode = useLookMode(look.normalize)
  const video = useVideoSettings()

  const changeLook = useCallback((next: LookSettings) => setLook(next).catch(reportError), [])
  const canExport = !busy && count >= 2
  const openExport = useCallback(() => {
    if (canExport) useView.getState().setExportOpen(true)
  }, [canExport])
  // From the look last asked for, so a second N before the first answer turns it back off (L3).
  const toggleLook = () => {
    const from = requestedLook() ?? look
    void changeLook({ ...from, normalize: from.normalize === 'off' ? lookMode : 'off' })
  }
  usePrimaryAction(aligning ? null : openExport)
  useTimelapseKeys({ enabled: !aligning, frames, frame, openExport, toggleLook })

  if (!session || !info || !video) return null
  const base = info.imageBaseUrl
  const ref = session.reference
  const frameAr = ref ? `${ref.crop.width} / ${ref.crop.height}` : '3 / 4'
  const aspect = ref ? ref.crop.width / ref.crop.height : 3 / 4
  const { done, total } = alignCounts(align)
  const subtitle = aligning
    ? `Aligning ${formatCount(done)} of ${formatCount(total)}`
    : framesSubtitle(count, frames[0]?.dayKey ?? null, frames[count - 1]?.dayKey ?? null)
  const transport = <Transport count={aligning ? 0 : count} disabled={aligning || count === 0} video={video} />
  const stage = aligning ? (
    <AligningStage base={base} frameAr={frameAr} aspect={aspect} track={align} transport={transport} />
  ) : mode === 'grid' ? (
    <FrameSheet frames={frames} base={base} current={index} medianResidual={medianResidual} aspect={aspect} onOpen={openFrame} />
  ) : (
    <PlayerStage
      frames={frames}
      base={base}
      frameAr={frameAr}
      aspect={aspect}
      index={index}
      reference={ref}
      referenceAnchors={framesView?.referenceAnchors ?? null}
      video={video}
      medianResidual={medianResidual}
      look={look}
      onLook={changeLook}
      lookMode={lookMode}
      failures={failuresOpen ? (align.summary?.failed ?? []) : []}
      onDismissFailures={() => setFailuresOpen(false)}
      transport={transport}
    />
  )

  const tools = (
    <TimelapseTools
      aligning={aligning}
      busy={busy}
      canExport={canExport}
      inspector={inspectorOpen}
      onInspector={useView.getState().toggleInspector}
      onExport={openExport}
    />
  )
  return (
    <Screen
      title="Timelapse"
      subtitle={subtitle}
      center={<ViewSwitch disabled={aligning} />}
      tools={tools}
      ribbon={<TimelapseRibbon frames={frames} recent={align.recent} aligning={aligning} frame={frame} />}
    >
      <div className="tl" style={{ ['--frame-ar' as string]: frameAr }}>
        {stage}
        {inspectorOpen && frame && !aligning ? <Inspector frame={frame} busy={busy} /> : null}
      </div>
      <AlignAnnouncer aligning={aligning} track={align} count={count} />
      {viewer ? <Viewer /> : null}
    </Screen>
  )
}
