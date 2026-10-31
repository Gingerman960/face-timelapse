import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { AppInfo, FramesView, ImageExportSettings, SessionSnapshot, VideoSettings } from '../../ipc/contract'
import { call } from '../../ipc/client'
import { useFocusTrap } from '../../components/ui/Overlays'
import { DataText } from '../../components/ui/DataText'
import { canAnimate, useExit } from '../../components/ui/presence'
import { usePrimaryAction } from '../../hooks/useKeys'
import { openPath, reportError, setLook } from '../../state/actions'
import { resetExportTracks, startExportImages, startExportVideo, useJobs } from '../../state/jobs'
import { usePlayer } from '../../state/player'
import { useAppInfo, useFrames, useSession } from '../../state/queries'
import { getVideoSettings, setVideoSettings, useVideoSettings } from '../../state/video'
import { useView } from '../../state/view'
import { useMaxWidth } from '../shell/useTheme'
import { useLookMode } from '../timelapse/useLookMode'
import { framePlanFor } from '../../lib/video'
import { DoneBody, EncodingBody, ExportAnnouncer, SettingsBody, StopNotice, encodingProgress, type SheetPhase } from './ExportBodies'
import { ExportFooter } from './ExportFooter'
import { encodingDay, exportSubtitle, planExport, suggestedVideoName, videoLengthGroups, type ExportFormat } from './exportModel'
import { useSheetMorph } from './useSheetMorph'
import './export.css'

interface DialogProps {
  frameRef: RefObject<HTMLDivElement | null>
  sheetRef: RefObject<HTMLElement | null>
  session: SessionSnapshot
  /** The video settings in effect, shared with the player and the ledger (QA N4). */
  video: VideoSettings
  info: AppInfo
  framesView: FramesView
  encoding: boolean
  /** The sheet is playing its exit: it takes no more actions. */
  closing: boolean
  close: () => void
  /** Opens the saved video in its default app (contract v1.7 `open_path`). */
  play: () => void
  /** Watches the timelapse here, from its first frame (a click on the diptych). */
  watch: () => void
}

/** Opens the save dialog for the format, then starts the export (a cancelled dialog does nothing). */
async function exportTo(format: ExportFormat, first: string | null, last: string | null, video: VideoSettings, images: ImageExportSettings): Promise<void> {
  try {
    if (format === 'video') {
      const path = await call('pick_video_path', { suggestedName: suggestedVideoName(first, last) })
      if (path) await startExportVideo(path, video)
    } else {
      const dir = await call('pick_export_folder')
      if (dir) await startExportImages(dir, images)
    }
  } catch (e) {
    reportError(e)
  }
}

/**
 * Plays the timelapse here from its first frame (the diptych's click; Play
 * opens the saved file, contract v1.7). From the Sheet view the
 * player comes back first, or playback would start with nothing to show and
 * resume by itself later (UI review 5, M1).
 */
function playFromStart(): void {
  if (useView.getState().timelapseMode !== 'player') useView.getState().setTimelapseMode('player')
  const player = usePlayer.getState()
  player.setIndex(0)
  if (!usePlayer.getState().playing) player.shuttle('l')
}

/** When a new phase takes away the focused control (Export…, Stop), focus stays in the sheet. */
function useFocusKeptOnPhase(sheet: RefObject<HTMLElement | null>, phase: SheetPhase): void {
  const shown = useRef(phase)
  useLayoutEffect(() => {
    if (shown.current === phase) return
    shown.current = phase
    const el = sheet.current
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
  }, [sheet, phase])
}

/** The sheet itself: it morphs in place from settings to progress to the result. */
function ExportDialog({ frameRef, sheetRef, session, video: vs, info, framesView, encoding, closing, close, play, watch }: DialogProps) {
  const index = usePlayer((s) => s.settled)
  const video = useJobs((s) => s.exportVideo)
  const images = useJobs((s) => s.exportImages)
  const [format, setFormat] = useState<ExportFormat>('video')
  const [imgSettings, setImgSettings] = useState<ImageExportSettings | null>(null)
  // The frame settings as last set, for ⌘↩ right after a field committed (before a re-render).
  const latestImages = useRef<ImageExportSettings | null>(null)
  const onImages = useCallback((next: ImageExportSettings) => {
    latestImages.current = next
    setImgSettings(next)
  }, [])
  const shade = useRef<HTMLDivElement>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const lookMode = useLookMode(framesView.look.normalize)
  const frames = framesView.frames
  const count = frames.length
  const first = frames[0]?.dayKey ?? null
  const last = frames[count - 1]?.dayKey ?? null
  const is: ImageExportSettings = imgSettings ?? session.imageExport
  const master = framesView.outputSize
  const light = framesView.look.normalize
  const plan = planExport(format, count, vs, is, master, framesView.render.resolution, light)
  const track = format === 'video' ? video : images
  const phase: SheetPhase = encoding ? 'encoding' : track.summary ? 'done' : 'settings'
  const progress = encodingProgress(format, video, images)
  // Encoding counts days (critique round 5, P1-7): the day of the video frame being written,
  // and the video by its length on the data line (critique round 6, P2-7).
  const framePlan = format === 'video' && plan.timing ? framePlanFor(count, vs, plan.timing.fps) : null
  const day = encodingDay(progress.done, progress.total, framePlan, count)
  const lead = format === 'video' ? videoLengthGroups(plan.timing?.durationSecs ?? null, plan.timing?.fps ?? null) : plan.groups
  const phaseRef = useSheetMorph(sheetRef, shade, ghost, phase)
  useFocusKeptOnPhase(sheetRef, phase)
  // The settings in effect when the export is asked for, read then rather than from this render:
  // ⌘↩ in a field commits it in the same keystroke (UI review 2, M5).
  const exportNow = () => {
    const video = getVideoSettings() ?? vs
    const images = latestImages.current ?? is
    if (planExport(format, count, video, images, master, framesView.render.resolution, light).canExport) void exportTo(format, first, last, video, images)
  }
  const onLook = (on: boolean) => void setLook({ ...framesView.look, normalize: on ? lookMode : 'off' }).catch(reportError)
  // ⌘↩ works from anywhere while the sheet is open (QA LOW): in a field of the sheet through its
  // own key handler, elsewhere through the stacked primary action. Settings: export. Saved: Play
  // (a video) or Done (frames).
  const primary = () => {
    if (closing) return
    if (phase === 'settings') exportNow()
    else if (phase === 'done') (format === 'video' ? play : close)()
  }
  usePrimaryAction(primary, { modal: true })
  const onKeyDown = (e: KeyboardEvent) => {
    if (!((e.metaKey || e.ctrlKey) && e.key === 'Enter')) return
    e.preventDefault()
    primary()
  }
  return (
    <div ref={frameRef} className="sheet-frame">
      <div ref={shade} className="sheet-shade" aria-hidden="true" />
      <section
        ref={sheetRef}
        className="sheet"
        role="dialog"
        // Modal only while open: a leaving sheet must not hold the screen's keys for its exit (UI review 5, L1).
        aria-modal={!closing}
        aria-labelledby="export-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ ['--frame-ar' as string]: master ? `${master.width} / ${master.height}` : '3 / 4' }}
      >
        <header className="sheet-head">
          <h2 id="export-title">Export timelapse</h2>
          <DataText as="p">{exportSubtitle(count, first, last)}</DataText>
        </header>
        <div key={phase} ref={phaseRef} className="sheet-phase">
          {phase === 'settings' ? (
            <SettingsBody
              base={info.imageBaseUrl}
              format={format}
              onFormat={setFormat}
              video={vs}
              onVideo={setVideoSettings}
              images={is}
              onImages={onImages}
              count={count}
              preview={frames[Math.min(index, count - 1)]}
              facts={plan.facts}
              master={master}
              masterResolution={framesView.render.resolution}
              lookOn={framesView.look.normalize !== 'off'}
              onLook={onLook}
            />
          ) : phase === 'encoding' ? (
            <EncodingBody base={info.imageBaseUrl} format={format} frames={frames} progress={progress} day={day} lead={lead} />
          ) : (
            <DoneBody base={info.imageBaseUrl} format={format} frames={frames} master={master} video={video} images={images} onWatch={format === 'video' ? watch : undefined} />
          )}
          {phase === 'settings' ? <StopNotice track={track} /> : null}
          <ExportFooter
            phase={phase}
            format={format}
            canExport={plan.canExport}
            onExport={exportNow}
            onClose={close}
            onPlay={play}
            savedPath={video.summary?.path ?? images.summary?.dir ?? ''}
          />
        </div>
        {/* The outgoing phase fades out here while the sheet morphs (useSheetMorph). */}
        <div ref={ghost} className="sheet-ghost" aria-hidden="true" inert />
        <ExportAnnouncer phase={phase} format={format} progress={progress} day={day} days={count} video={video} images={images} />
      </section>
    </div>
  )
}

/**
 * Export: a modal sheet over the timelapse. Opening it pauses playback, so the
 * preview is the frame on screen. Closing plays its exit (200 ms) as an inert
 * layer: focus goes back and Escape reaches the screen at once.
 */
export default function ExportSheet() {
  const session = useSession().data
  const info = useAppInfo().data
  const framesView = useFrames().data
  const videoSettings = useVideoSettings()
  const setOpen = useView((s) => s.setExportOpen)
  const narrow = useMaxWidth(1180)
  const kind = useJobs((s) => s.activeKind)
  const encoding = kind === 'exportVideo' || kind === 'exportImages'
  const sheet = useRef<HTMLElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  // Tracks reset only once the sheet is gone, so the saved phase doesn't turn back into the settings as it leaves.
  const finish = useCallback(() => {
    resetExportTracks()
    setOpen(false)
  }, [setOpen])
  const close = useCallback(() => {
    if (encoding || closing) return
    if (canAnimate()) setClosing(true)
    else finish()
  }, [encoding, closing, finish])
  const savedVideo = useJobs((s) => s.exportVideo.summary?.path ?? null)
  const play = useCallback(() => {
    if (encoding || closing || !savedVideo) return
    void openPath(savedVideo).then((opened) => {
      if (opened) close()
    })
  }, [encoding, closing, close, savedVideo])
  const watch = useCallback(() => {
    if (encoding || closing) return
    playFromStart()
    close()
  }, [encoding, closing, close])
  useFocusTrap(sheet, !closing, close, encoding)
  useExit(
    closing,
    [
      { ref: frame, kind: 'sheet' },
      { ref: scrim, kind: 'scrim' },
    ],
    finish,
  )
  useEffect(() => {
    usePlayer.getState().pause()
  }, [])
  if (!session || !info || !framesView || !videoSettings) return null
  return (
    <div className="sheet-layer" data-compact={narrow || undefined} inert={closing} data-leaving={closing || undefined}>
      <div ref={scrim} className="sheet-scrim" onClick={close} aria-hidden="true" />
      <ExportDialog
        frameRef={frame}
        sheetRef={sheet}
        session={session}
        video={videoSettings}
        info={info}
        framesView={framesView}
        encoding={encoding}
        closing={closing}
        close={close}
        play={play}
        watch={watch}
      />
    </div>
  )
}
