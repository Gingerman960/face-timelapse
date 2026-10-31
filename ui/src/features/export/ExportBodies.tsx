import { Fragment, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Play } from '@phosphor-icons/react'
import { DataText } from '../../components/ui/DataText'
import type { FrameSummary, ImageExportSettings, Resolution, Size, VideoSettings } from '../../ipc/contract'
import { alignedUrl } from '../../ipc/images'
import { strftime } from '../../lib/dates'
import { countOf, formatCount } from '../../lib/format'
import { Facts, Meter } from '../../components/ui/Controls'
import { Notice } from '../../components/ui/Overlays'
import { ProgressAnnouncer } from '../../components/ui/ProgressAnnouncer'
import { RetryImg } from '../../components/ui/RetryImg'
import { Segmented, type SegmentOption } from '../../components/ui/Segmented'
import { usePathDisplay } from '../../hooks/usePathDisplay'
import type { JobsState } from '../../state/jobs'
import { captionStyle, encodingDataGroups, encodingHeading, savedFacts, tookText, type ExportFact, type ExportFormat, type SummaryGroups } from './exportModel'
import { FramesForm } from './FramesForm'
import { Diptych, EncodingPrint } from './Prints'
import { told, useSavedSequence } from './useSavedSequence'
import { useStepped } from './useStepped'
import { VideoForm } from './VideoForm'

type VideoTrack = JobsState['exportVideo']
type ImagesTrack = JobsState['exportImages']
export type SheetPhase = 'settings' | 'encoding' | 'done'

/** CSS width of the preview and encoding frames. */
const PREVIEW_W = 196
const ENCODING_W = 136
/** The encoding print steps to the day being written about once a second (critique round 5, P2-16). */
const ENCODING_STEP_MS = 1000

const FORMATS: ReadonlyArray<SegmentOption<ExportFormat>> = [
  { value: 'video', label: 'Video (MP4)' },
  { value: 'frames', label: 'Frames' },
]

function usePreviewHeight() {
  const ref = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(260)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, h }
}

interface SettingsBodyProps {
  base: string
  format: ExportFormat
  onFormat: (format: ExportFormat) => void
  video: VideoSettings
  onVideo: (next: VideoSettings) => void
  images: ImageExportSettings
  onImages: (next: ImageExportSettings) => void
  count: number
  /** The frame at the playhead, read once when the sheet opened. */
  preview: FrameSummary | undefined
  /** The export as configured, shown under the preview. */
  facts: readonly ExportFact[]
  master: Size | null
  masterResolution: Resolution
  lookOn: boolean
  onLook: (on: boolean) => void
}

/** The facts under the preview: words in the UI face, values in the data font. */
function ExportFacts({ facts }: { facts: readonly ExportFact[] }) {
  return <Facts className="export-facts" rows={facts.map((f) => ({ label: f.label, value: <DataLine groups={[f.parts]} />, mono: false }))} />
}

/**
 * Settings: the current frame with its burned-in caption, and under it the
 * export as facts (critique round 4, item 25: they were a footer line, and
 * this column stood empty), beside the form.
 */
export function SettingsBody(props: SettingsBodyProps) {
  const { base, format, onFormat, video, onVideo, images, onImages, count, preview, facts, master, masterResolution, lookOn, onLook } = props
  const { ref: previewRef, h: previewH } = usePreviewHeight()
  const caption = format === 'video' && video.caption && preview ? video.caption : null
  const src = preview ? alignedUrl(base, { photoId: preview.photoId, version: preview.version }, PREVIEW_W, window.devicePixelRatio) : null
  return (
    <div className="sheet-body">
      <div className="export-aside">
        <div ref={previewRef} className="ep-frame">
          {src ? <RetryImg src={src} alt="Preview of the current frame" /> : null}
          {caption && preview ? (
            <span className="ep-caption" style={captionStyle(caption.position, caption.size, previewH)}>
              {strftime(caption.format, preview.dayKey)}
            </span>
          ) : null}
        </div>
        <ExportFacts facts={facts} />
      </div>
      <div className="form">
        <div className="field">
          <span className="field-label">Format</span>
          <Segmented<ExportFormat> label="Format" value={format} onChange={onFormat} options={FORMATS} />
        </div>
        {format === 'video' ? (
          <VideoForm
            settings={video}
            onChange={onVideo}
            count={count}
            master={master}
            masterResolution={masterResolution}
            sampleDay={preview?.dayKey ?? '2014-08-14'}
            lookOn={lookOn}
            onLook={onLook}
          />
        ) : (
          <FramesForm settings={images} onChange={onImages} lookOn={lookOn} onLook={onLook} />
        )}
      </div>
    </div>
  )
}

/** A summary line: words in the UI face, only the values in the data font (P2-13). */
export function DataLine({ groups }: { groups: SummaryGroups }) {
  return (
    <>
      {groups.map((group, i) => (
        <Fragment key={i}>
          {i > 0 ? ' · ' : null}
          {group.map((part, j) =>
            part.value ? (
              <span key={j} className="mono">
                {part.text}
              </span>
            ) : (
              <Fragment key={j}>{part.text}</Fragment>
            ),
          )}
        </Fragment>
      ))}
    </>
  )
}

/** Frames done, to do and the time left for the running export. */
export function encodingProgress(format: ExportFormat, video: VideoTrack, images: ImagesTrack): { done: number; total: number; etaMs: number | null } {
  if (format === 'video') {
    const p = video.progress
    return { done: p?.framesDone ?? 0, total: p?.framesTotal ?? video.total, etaMs: p?.etaMs ?? null }
  }
  const p = images.progress
  return { done: p?.done ?? 0, total: p?.total ?? images.total, etaMs: p?.etaMs ?? null }
}

interface EncodingBodyProps {
  base: string
  format: ExportFormat
  frames: readonly FrameSummary[]
  progress: { done: number; total: number; etaMs: number | null }
  /** The day being written, 1-based (encodingDay). */
  day: number
  /** What is being written, for the data line: "2:59.6 of video · 60 fps", or the files. */
  lead: SummaryGroups
}

/**
 * Encoding (critique round 5, P1-7 and P2-16): the count is in days at heading
 * size ("Encoding day 14 of 3,573", only the numerals in the data font), and
 * the video is given by its length on the data line under it ("2:59.6 of
 * video · 60 fps · about 12 s left"). The print beside it steps to the day
 * being written about once a second, cross-fading over latent film, and a
 * meter runs the sheet's width under both. Speech goes through ExportAnnouncer.
 */
export function EncodingBody({ base, format, frames, progress, day, lead }: EncodingBodyProps) {
  const shownDay = useStepped(day, ENCODING_STEP_MS)
  const frame = shownDay > 0 ? frames[shownDay - 1] : undefined
  const src = frame ? alignedUrl(base, { photoId: frame.photoId, version: frame.version }, ENCODING_W, window.devicePixelRatio) : null
  return (
    <div className="sheet-progress">
      <EncodingPrint className="enc-frame" src={src} />
      <div className="enc-copy">
        <DataText as="p" className="enc-num">
          {encodingHeading(format, day, frames.length)}
        </DataText>
        <p className="data-line">
          <DataLine groups={encodingDataGroups(lead, progress.etaMs)} />
        </p>
      </div>
      <Meter value={progress.done} max={Math.max(1, progress.total)} label="Export progress" />
    </div>
  )
}

/** File name of a saved video. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

interface DoneBodyProps {
  base: string
  format: ExportFormat
  frames: readonly FrameSummary[]
  master: Size | null
  video: VideoTrack
  images: ImagesTrack
  /** Watches the timelapse here (a saved video only): the spread is that button; Play opens the file. */
  onWatch?: () => void
}

/** Which of the two prints have their images in. */
type Loaded = readonly [boolean, boolean]

/**
 * Saved (critique round 5, P2-11): the decade as a photobook spread of its
 * first and last days, developed one after the other and ticked with the pen
 * across the gutter once both are up; then "Saved · 2:59.6 · 648 MB" and what
 * was written. A save that lands while the window is hidden waits to be seen
 * (useSavedSequence). The spread is the in-sheet "Watch here". Paths show
 * short ("~", middle truncation) with the full path in the tooltip (QA 29);
 * Show in Finder still gets the real one.
 */
export function DoneBody({ base, format, frames, master, video, images, onWatch }: DoneBodyProps) {
  const showPath = usePathDisplay()
  const v = format === 'video' ? video.summary : null
  const i = images.summary
  const first = frames[0]
  const last = frames[frames.length - 1]
  const [loaded, setLoaded] = useState<Loaded>([false, false])
  const onLoaded = useCallback((n: 0 | 1) => setLoaded((l): Loaded => (l[n] ? l : n === 0 ? [true, l[1]] : [l[0], true])), [])
  const stage = useSavedSequence(loaded, Boolean(first && last))
  const facts = v ? savedFacts({ kind: 'video', durationSecs: v.durationSecs, bytes: v.bytes }) : i ? savedFacts({ kind: 'frames', written: i.written }) : null
  const took = v ? tookText(v.elapsedMs) : i ? tookText(i.durationMs) : null
  const spread = first && last ? <Diptych base={base} first={first} last={last} master={master} stage={stage} onLoaded={onLoaded} /> : null
  return (
    <div className="sheet-done">
      {spread && onWatch ? (
        <button type="button" className="diptych-watch" aria-label="Watch here" title="Watch the timelapse here, from the first day" onClick={onWatch}>
          {spread}
          <span className="diptych-cue" aria-hidden="true">
            <Play className="icon" weight="fill" />
            Watch here
          </span>
        </button>
      ) : (
        spread
      )}
      <div className="saved-copy" data-told={told(stage) || undefined}>
        <div className="saved-lead">
          <h3>Saved</h3> {facts ? <DataText className="saved-facts">{`· ${facts}`}</DataText> : null}
        </div>
        {v ? (
          <p className="data-line">
            <span title={v.path}>{fileName(v.path)}</span>
            {took ? ` · ${took}` : null}
          </p>
        ) : i ? (
          <p className="data-line">
            <span title={i.dir}>{showPath(i.dir)}</span>
            {i.renamed > 0 ? (
              <>
                {' · '}
                <span className="mono">{formatCount(i.renamed)}</span> got a _1 suffix
              </>
            ) : null}
            {took ? ` · ${took}` : null}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** The stop notice after a failed or cancelled export (shown with the settings). */
export function StopNotice({ track }: { track: VideoTrack | ImagesTrack }) {
  if (track.error) {
    return (
      <Notice tone="stop" title="The export stopped.">
        {track.error.message} Nothing half-written was left behind.
      </Notice>
    )
  }
  if (track.cancelledAt !== null) return <Notice tone="safelight">Export stopped. Nothing half-written was left behind.</Notice>
  return null
}

interface ExportAnnouncerProps {
  phase: SheetPhase
  format: ExportFormat
  progress: { done: number; total: number }
  /** The day being written and how many there are (the count the sheet shows). */
  day: number
  days: number
  video: VideoTrack
  images: ImagesTrack
}

/** Speaks the export through one throttled live region: start, every 10 % (in days) and when it is saved. */
export function ExportAnnouncer({ phase, format, progress, day, days, video, images }: ExportAnnouncerProps) {
  const verb = format === 'video' ? 'Encoding' : 'Saving'
  const saved = format === 'video' && video.summary ? `Saved ${fileName(video.summary.path)}.` : `Saved ${countOf(images.summary?.written ?? 0, 'file')}.`
  const counted = progress.total > 0 ? `${encodingHeading(format, day, days)}.` : `${verb} started.`
  const message = phase === 'encoding' ? counted : saved
  const spoken = phase === 'encoding' ? 'running' : phase === 'done' ? 'done' : null
  return <ProgressAnnouncer phase={spoken} fraction={phase === 'encoding' ? progress.done / Math.max(1, progress.total) : null} message={message} />
}
