import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Stop, X } from '@phosphor-icons/react'
import type { DayGroup, DayKey, FolderInfo, MatchStatus, PhotoSummary, ScanProgress, ScanRecent, SessionSnapshot } from '../../ipc/contract'
import { thumbUrl } from '../../ipc/images'
import { countOf, formatCount, formatEta } from '../../lib/format'
import { formatDay } from '../../lib/dates'
import { PlateButton, QuietButton, StopButton } from '../../components/ui/Button'
import { Meter } from '../../components/ui/Controls'
import { DataText } from '../../components/ui/DataText'
import { Notice, Popover } from '../../components/ui/Overlays'
import { Segmented } from '../../components/ui/Segmented'
import { usePrimaryAction } from '../../hooks/useKeys'
import { pickSourceFolder, reportError, setReviewDecision } from '../../state/actions'
import { cancelActiveJob, startScan, useJobs } from '../../state/jobs'
import { useAppInfo, useDays, usePhotos, useSession } from '../../state/queries'
import { useModelsBlock } from '../../state/models'
import { useView, type ScanFilter } from '../../state/view'
import { DecadeRibbon } from '../shell/DecadeRibbon'
import { ProgressAnnouncer } from '../../components/ui/ProgressAnnouncer'
import { Screen } from '../shell/Screen'
import { ContactSheet, type SheetItem } from './ContactSheet'
import { ScanEmpty } from './ScanEmpty'
import { firstItemOnOrAfter, libraryTally, liveFocusYear, liveTally, readTimeText, visibleDays } from './scanModel'
import { Tally } from './Tally'
import './scan.css'
import { usePathDisplay } from '../../hooks/usePathDisplay'

/** The ribbon loupe's face, CSS px (DESIGN: 160 px). */
const LOUPE_PX = 160
const UNSURE: MatchStatus[] = ['uncertain']

const FILTER_STATUSES: Record<ScanFilter, MatchStatus[] | null> = {
  all: null,
  confirmed: ['confirmed'],
  uncertain: ['uncertain'],
  rejected: ['rejected'],
  noFace: ['noFace', 'failed'],
}

/** Whole calendar years around a set of day keys (the ribbon span). */
export function yearSpan(keys: Iterable<string>, fallback: [string, string] = ['2012-01-01', '2022-12-31']): [string, string] {
  let min: string | null = null
  let max: string | null = null
  for (const k of keys) {
    if (min === null || k < min) min = k
    if (max === null || k > max) max = k
  }
  if (!min || !max) return fallback
  return [`${min.slice(0, 4)}-01-01`, `${max.slice(0, 4)}-12-31`]
}

function toSheetItem(p: PhotoSummary): SheetItem {
  const tag = p.status === 'rejected' && p.review !== 'confirmed' ? 'Not you' : p.status === 'noFace' ? 'No face' : p.status === 'failed' ? 'Unreadable' : p.review === 'rejected' ? 'Left out' : undefined
  return {
    id: p.id,
    version: p.version,
    dayKey: p.dayKey,
    unsure: p.status === 'uncertain' && p.review === 'pending',
    dim: !p.included,
    tag,
    label: `${p.fileName}, ${p.dayKey}${tag ? `, ${tag}` : ''}`,
  }
}

/** Title, subtitle and tools of the Scan screen, shared by its live and library views. */
interface ScanChrome {
  subtitle: ReactNode
  tools: ReactNode
}

const NO_PROGRESS = { confirmed: 0, uncertain: 0, rejected: 0, noFace: 0, fromCache: 0, failed: 0 }

/** The library ribbon's days: present, picked by hand, left out, and each day's group for the loupe. */
function ribbonDays(days: readonly DayGroup[] | undefined) {
  const byDay = new Map<DayKey, DayGroup>((days ?? []).map((d) => [d.dayKey, d]))
  const groups = [...byDay.values()]
  return {
    byDay,
    present: new Set(byDay.keys()),
    mine: new Set(groups.filter((d) => d.manualSelection).map((d) => d.dayKey)),
    excluded: new Set(groups.filter((d) => d.excluded).map((d) => d.dayKey)),
  }
}

/**
 * The live sheet's frames, made once per photo read: the progress list keeps
 * its entries as it grows, so a progress event hands the sheet the same items
 * and only the new frames render.
 */
const liveItems = new WeakMap<ScanRecent, SheetItem>()

function liveItem(r: ScanRecent): SheetItem {
  const known = liveItems.get(r)
  if (known) return known
  const unsure = r.status === 'uncertain'
  const item: SheetItem = { id: r.id, version: r.version, dayKey: r.dayKey, unsure, label: `${formatDay(r.dayKey)}${unsure ? ', unsure' : ''}` }
  liveItems.set(r, item)
  return item
}

/**
 * The live ribbon's focus year: the year with the most days found, held until
 * another overtakes it (photos come in no order of date, so the last one read would
 * jump years every row; critique round 5, P2-9).
 */
function useLiveFocusYear(found: ReadonlySet<DayKey>): number | null {
  const [held, setHeld] = useState<number | null>(null)
  const next = liveFocusYear(found, held)
  if (next !== held) setHeld(next)
  return next
}

type RateProgress = Pick<ScanProgress, 'photosPerSecond' | 'etaMs' | 'currentFile'>

/** The live scan's rate line: how fast, how long, and the file being read. Prose in the UI face; only data in the data font. */
export function LiveRate({ progress, workers }: { progress: RateProgress | null; workers: number | undefined }) {
  return (
    <div className="scan-rate">
      <DataText>{`${Math.round(progress?.photosPerSecond ?? 0)} photos/s · ${workers ?? '–'} workers`}</DataText>
      <strong>{formatEta(progress?.etaMs ?? null)}</strong>
      {progress?.currentFile ? <span className="mono-meta file">{progress.currentFile}</span> : <span className="meta file">Starting…</span>}
    </div>
  )
}

function LiveScan({ chrome }: { chrome: ScanChrome }) {
  const info = useAppInfo().data
  const scan = useJobs((s) => s.scan)
  const p = scan.progress
  const total = p?.total ?? scan.total
  const items = useMemo<SheetItem[]>(() => scan.recent.map(liveItem), [scan.recent])
  const found = useMemo(() => new Set(scan.recent.map((r) => r.dayKey)), [scan.recent])
  const [start, end] = yearSpan(found)
  const focusYear = useLiveFocusYear(found) ?? Number(start.slice(0, 4))
  // Each day is exposed in its year as it's found, in whatever order the files are read.
  const ribbon = <DecadeRibbon start={start} end={end} present={found} exposedDays={found} focusYear={focusYear} label="Days found so far" />
  return (
    <Screen title="Scan" subtitle={chrome.subtitle} tools={chrome.tools} ribbon={ribbon}>
      <div className="scan-screen">
        <div className="scan-band">
          <div className="scan-line">
            <h2>
              Read <b>{formatCount(p?.done ?? 0)}</b> of {formatCount(total)} photos
            </h2>
            <Tally items={liveTally(p ?? NO_PROGRESS)} />
          </div>
          <LiveRate progress={p} workers={info?.parallelism} />
        </div>
        <Meter className="scan-meter" value={p?.done ?? 0} max={Math.max(1, total)} label="Scan progress" />
        <ProgressAnnouncer
          phase="running"
          fraction={total > 0 ? (p?.done ?? 0) / total : null}
          message={`Scanning. ${formatCount(p?.done ?? 0)} of ${formatCount(total)} photos read, ${formatCount(p?.confirmed ?? 0)} of them you.`}
        />
        <ContactSheet items={items} base={info?.imageBaseUrl ?? ''} follow reading ariaLabel="Matched photos, newest last" />
      </div>
    </Screen>
  )
}

/**
 * A scan that stopped part-way says so where its results are, not only in the
 * Reference inspector, which hides with ⌥⌘I (critique round 5, P3-26). The
 * same words as the inspector's: safelight for a stop, stop red for a failure.
 */
function ScanStopped({ folder, error }: { folder: FolderInfo | null | undefined; error: string | null }) {
  const where = folder ? `Stopped at ${formatCount(folder.analyzedCount)} of ${formatCount(folder.imageCount)}.` : null
  return (
    <div className="scan-stopped">
      {error ? (
        <Notice tone="stop" title="The scan stopped.">
          {error} {where} The next scan continues from here.
        </Notice>
      ) : (
        <Notice tone="safelight" title={where ?? 'The scan stopped part-way.'}>
          The next scan continues from here.
        </Notice>
      )}
    </div>
  )
}

function Library({ session, chrome }: { session: SessionSnapshot; chrome: ScanChrome }) {
  const info = useAppInfo().data
  const filter = useView((s) => s.scanFilter)
  const setFilter = useView((s) => s.setScanFilter)
  const photos = usePhotos(FILTER_STATUSES[filter])
  const days = useDays(session.scan.status === 'complete').data
  const [selected, setSelected] = useState<PhotoSummary | null>(null)
  const items = useMemo(() => (photos.data ?? []).map(toSheetItem), [photos.data])
  // The ribbon follows the rows on screen, and a seek on it scrolls the sheet (critique round 2).
  const [onScreen, setOnScreen] = useState<{ first: number; last: number }>({ first: 0, last: 0 })
  const [seek, setSeek] = useState<{ index: number } | null>(null)
  const onVisibleItems = useCallback((first: number, last: number) => setOnScreen({ first, last }), [])
  const span = useMemo(() => visibleDays(items, onScreen.first, onScreen.last), [items, onScreen])
  const byId = useMemo(() => new Map((photos.data ?? []).map((p) => [p.id, p])), [photos.data])
  const ribbonSets = useMemo(() => ribbonDays(days), [days])
  const [start, end] = yearSpan(ribbonSets.present)
  const c = session.counts
  const summary = session.scan.lastSummary
  // Kept and left out come from the review's decisions (critique round 4, P2-16).
  const unsure = usePhotos(UNSURE).data
  const tally = libraryTally(c, unsure, summary?.fromCache ?? 0)
  const partial = session.scan.status === 'partial'
  const scanError = useJobs((s) => s.scan.error)
  const base = info?.imageBaseUrl ?? ''
  const loupeUrl = useCallback(
    (day: DayKey) => {
      const group = ribbonSets.byDay.get(day)
      const photo = group ? byId.get(group.selectedId) : undefined
      return photo ? thumbUrl(base, { id: photo.id, version: photo.version }, LOUPE_PX, window.devicePixelRatio) : null
    },
    [ribbonSets, byId, base],
  )
  const decide = (decision: 'confirmed' | 'rejected') => {
    if (!selected) return
    void setReviewDecision([selected.id], decision)
      .then(() => setSelected(null))
      .catch(reportError)
  }
  const canDecide = selected !== null && selected.status !== 'noFace' && selected.status !== 'failed'
  const cursor = selected?.dayKey ?? span?.start ?? null
  const ribbon = (
    <DecadeRibbon
      start={start}
      end={end}
      present={ribbonSets.present}
      mine={ribbonSets.mine}
      excluded={ribbonSets.excluded}
      focusYear={Number((cursor ?? end).slice(0, 4))}
      cursor={cursor}
      visibleSpan={span}
      onSeek={(day) => setSeek({ index: firstItemOnOrAfter(items, day) })}
      loupeUrl={loupeUrl}
      label="Days with a photo"
    />
  )
  return (
    <Screen title="Scan" subtitle={chrome.subtitle} tools={chrome.tools} ribbon={ribbon}>
      <div className="scan-screen">
        <div className={partial ? 'scan-band is-stopped' : 'scan-band'}>
          <div className="scan-line">
            <h2>
              {session.scan.status === 'complete' ? (
                <>Found you in <b>{formatCount(c.confirmed)}</b> of {formatCount(c.total)} photos</>
              ) : (
                <>Stopped after <b>{formatCount(c.total)}</b> photos</>
              )}
            </h2>
            <Tally items={tally} />
          </div>
          <div className="scan-rate">
            {summary ? <DataText>{readTimeText(summary.durationMs)}</DataText> : null}
            <strong>{c.reviewPending > 0 ? `${formatCount(c.reviewPending)} ${c.reviewPending === 1 ? 'needs' : 'need'} your eye` : 'Nothing needs your eye'}</strong>
            {c.reviewPending > 0 ? <span className="meta">Unsure photos stay out unless you keep them.</span> : null}
          </div>
          {partial ? <ScanStopped folder={session.folder} error={scanError?.message ?? null} /> : null}
        </div>
        <div className="scan-filter">
          <Segmented<ScanFilter>
            label="Show"
            value={filter}
            onChange={(f) => {
              setFilter(f)
              setSelected(null)
            }}
            options={[
              { value: 'all', label: 'All' },
              { value: 'confirmed', label: 'You' },
              { value: 'uncertain', label: 'Unsure' },
              { value: 'rejected', label: 'Not you' },
              { value: 'noFace', label: 'No face' },
            ]}
          />
          {selected ? (
            <div className="row">
              <span className="hint mono-meta">{selected.fileName}</span>
              <QuietButton icon={<X className="icon" aria-hidden="true" />} disabled={!canDecide} onClick={() => decide('rejected')}>Leave out</QuietButton>
              <QuietButton icon={<Check className="icon" aria-hidden="true" />} disabled={!canDecide} onClick={() => decide('confirmed')}>Use this photo</QuietButton>
            </div>
          ) : (
            <span className="hint">Select a photo to keep it or leave it out.</span>
          )}
        </div>
        <ContactSheet
          items={items}
          base={base}
          selectedId={selected?.id ?? null}
          onSelect={(it) => setSelected(byId.get(it.id) ?? null)}
          ariaLabel="Photos in the library"
          empty={photos.isLoading ? 'Loading photos…' : 'No photos in this group.'}
          onVisibleItems={onVisibleItems}
          seek={seek}
        />
      </div>
    </Screen>
  )
}

/** Scan: the live contact sheet while reading; the library view afterwards. */
export default function ScanScreen() {
  const showPath = usePathDisplay()
  const session = useSession().data
  const running = useJobs((s) => s.activeKind === 'scan')
  const busy = useJobs((s) => s.activeJobId !== null)
  const setStep = useView((s) => s.setStep)
  const [confirmStop, setConfirmStop] = useState(false)
  const stopRef = useRef<HTMLButtonElement>(null)
  const pending = session?.counts.reviewPending ?? 0
  const partial = session?.scan.status === 'partial'
  // No results to show (N5): a scan that ended with no photos, or results lost to missing models.
  const empty = !running && !partial && session?.counts.total === 0
  const noPhotos = empty && session?.folder?.imageCount === 0
  const models = useModelsBlock()
  const scan = models ? null : () => void startScan().catch(reportError)
  const chooseFolder = () =>
    void pickSourceFolder()
      .then((folder) => {
        if (folder) setStep('setup')
      })
      .catch(reportError)
  const primary = running ? null : noPhotos ? chooseFolder : partial || empty ? scan : pending > 0 ? () => setStep('review') : () => setStep('days')
  usePrimaryAction(busy && !running ? null : primary)
  if (!session) return null
  const done = useJobs.getState().scan.progress?.done ?? 0

  const tools = running ? (
    <>
      <QuietButton ref={stopRef} icon={<Stop className="icon" aria-hidden="true" />} kbd="⌘." aria-expanded={confirmStop} onClick={() => setConfirmStop(true)}>
        Stop
      </QuietButton>
      <Popover anchor={stopRef} open={confirmStop} onClose={() => setConfirmStop(false)} labelledBy="stop-title">
        <h3 id="stop-title">Stop scanning?</h3>
        <p>The {formatCount(done)} photos read so far are remembered, so the next scan continues from here.</p>
        <div className="row end">
          <QuietButton onClick={() => setConfirmStop(false)}>Keep scanning</QuietButton>
          <StopButton
            onClick={() => {
              setConfirmStop(false)
              void cancelActiveJob()
            }}
          >
            Stop
          </StopButton>
        </div>
      </Popover>
    </>
  ) : noPhotos ? (
    <PlateButton kbd="⌘↩" onClick={chooseFolder} disabled={busy}>Choose another folder…</PlateButton>
  ) : partial || empty ? (
    <PlateButton kbd="⌘↩" onClick={primary ?? undefined} disabled={busy || models !== null} title={models ?? undefined}>{partial ? 'Resume scan' : 'Scan library'}</PlateButton>
  ) : pending > 0 ? (
    <>
      <QuietButton onClick={() => setStep('days')} disabled={busy}>Skip review</QuietButton>
      <PlateButton kbd="⌘↩" onClick={() => setStep('review')}>Review {formatCount(pending)} unsure</PlateButton>
    </>
  ) : (
    <PlateButton kbd="⌘↩" onClick={() => setStep('days')}>Continue to Days</PlateButton>
  )

  const folderPath = session.folder?.path
  const subtitle = running ? (
    `Looking for your face in ${countOf(session.folder?.imageCount ?? 0, 'photo')}`
  ) : folderPath ? (
    <span title={folderPath}>{showPath(folderPath)}</span>
  ) : null
  const chrome: ScanChrome = { subtitle, tools }
  if (empty) return <ScanEmpty reason={noPhotos ? 'noPhotos' : models ? 'models' : null} folder={session.folder} subtitle={subtitle} tools={tools} />
  return running ? <LiveScan chrome={chrome} /> : <Library session={session} chrome={chrome} />
}
