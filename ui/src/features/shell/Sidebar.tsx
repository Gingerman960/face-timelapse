import { useMemo, useRef, useState } from 'react'
import { CalendarDots, CircleHalf, FilmStrip, HardDrives, Scan, SealQuestion, UserFocus } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { LoopMark } from '../../components/ui/Mark'
import { Popover } from '../../components/ui/Overlays'
import { Segmented } from '../../components/ui/Segmented'
import { IconButton } from '../../components/ui/Button'
import { referenceFrameUrl } from '../../ipc/images'
import { useAppInfo, useCachedPhotos, useDays, useSession } from '../../state/queries'
import { useVideoSettings } from '../../state/video'
import { useJobs } from '../../state/jobs'
import { useView, type Theme } from '../../state/view'
import { countOf, formatCount, thisMachine } from '../../lib/format'
import { ModelsNotice } from './ModelsNotice'
import { deriveLedger, ledgerIdForStep, type LedgerId, type LedgerRow, type LiveJob } from './ledger'
import { StartOverButton } from './StartOver'
import { RetryImg } from '../../components/ui/RetryImg'
import { preloadScreen } from './screens'
import { useKeyMap } from './keyMapStore'

const GLYPHS: Record<LedgerId, Icon> = {
  setup: UserFocus,
  scan: Scan,
  review: SealQuestion,
  days: CalendarDots,
  timelapse: FilmStrip,
}

/** Live progress of whichever job runs, normalized for the ledger. */
export function useLiveJob(): LiveJob | null {
  const kind = useJobs((s) => s.activeKind)
  const scan = useJobs((s) => s.scan.progress)
  const align = useJobs((s) => s.align.progress)
  const video = useJobs((s) => s.exportVideo.progress)
  const images = useJobs((s) => s.exportImages.progress)
  return useMemo(() => {
    if (kind === 'scan') return { kind, done: scan?.done ?? 0, total: scan?.total ?? 0, etaMs: scan?.etaMs ?? null }
    if (kind === 'align') return { kind, done: align?.done ?? 0, total: align?.total ?? 0, etaMs: align?.etaMs ?? null }
    if (kind === 'exportVideo') return { kind, done: video?.framesDone ?? 0, total: video?.framesTotal ?? 0, etaMs: video?.etaMs ?? null }
    if (kind === 'exportImages') return { kind, done: images?.done ?? 0, total: images?.total ?? 0, etaMs: images?.etaMs ?? null }
    return null
  }, [kind, scan, align, video, images])
}

function LedgerButton({ row, current }: { row: LedgerRow; current: boolean }) {
  const setStep = useView((s) => s.setStep)
  const Glyph = GLYPHS[row.id]
  const locked = !row.reachable
  return (
    <li>
      <button
        type="button"
        className="stage"
        aria-current={current ? 'page' : undefined}
        aria-disabled={locked || undefined}
        // In the rail the names are visually hidden, so the tooltip says it all (critique round 4).
        title={`${row.label} · ${row.text} ${row.shortcut}`}
        onPointerEnter={locked ? undefined : () => preloadScreen(row.step)}
        onClick={() => {
          if (!locked) setStep(row.step)
        }}
      >
        <span className="stage-glyph" aria-hidden="true">
          <Glyph className="icon" />
          {/* "Where you are", written with the pen as the stage becomes current. */}
          <LoopMark draw={current} />
        </span>
        <span className="stage-name">{row.label}</span>
        <span className="stage-status">
          {row.status === 'attention' ? <b className="dot-safelight" aria-hidden="true" /> : null}
          {row.text}
        </span>
        <kbd className="stage-key" aria-hidden="true">
          {row.shortcut}
        </kbd>
        {row.progress !== null ? (
          <span className="stage-meter" role="progressbar" aria-label={`${row.label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.progress * 100)}>
            <i style={{ ['--p' as string]: row.progress }} />
          </span>
        ) : null}
      </button>
    </li>
  )
}

function ProjectHeader() {
  const session = useSession().data
  const info = useAppInfo().data
  const days = useDays(session?.scan.status === 'complete').data
  const ref = session?.reference
  const folder = session?.folder
  // The decade names the project once it is known ("2012 – 2022"); the folder and its count go under it (critique round 4).
  const first = days?.[0]?.dayKey.slice(0, 4)
  const last = days?.[days.length - 1]?.dayKey.slice(0, 4)
  const years = first && last ? (first === last ? first : `${first} – ${last}`) : null
  const title = years ?? folder?.name ?? 'New timelapse'
  const meta = folder ? (years ? `${folder.name} · ${formatCount(folder.imageCount)}` : countOf(folder.imageCount, 'photo')) : 'No photos yet'
  return (
    <header className="project">
      {ref && info ? (
        <RetryImg className="project-ref" src={referenceFrameUrl(info.imageBaseUrl, ref.version, 36, window.devicePixelRatio)} alt="" width={36} height={45} />
      ) : (
        <span className="project-ref empty" aria-hidden="true" />
      )}
      <div className="project-meta">
        <strong dir="auto">{title}</strong>
        <span className="meta" title={meta} dir="auto">
          {meta}
        </span>
      </div>
      {ref || folder ? <StartOverButton /> : null}
    </header>
  )
}

/**
 * "? Keys" (critique round 6, P1-3): the quiet way to the Keys card, so "?"
 * is written somewhere outside the card. The rail keeps only the cap.
 */
function KeysHint() {
  const toggle = useKeyMap((s) => s.toggle)
  return (
    <button type="button" className="keys-hint" aria-label="Keys" title="Keys for this screen (?)" onClick={toggle}>
      <kbd aria-hidden="true">?</kbd>
      <span className="keys-word" aria-hidden="true">
        Keys
      </span>
    </button>
  )
}

function AppearanceButton() {
  const theme = useView((s) => s.theme)
  const setTheme = useView((s) => s.setTheme)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <IconButton ref={anchor} small label="Appearance" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <CircleHalf className="icon" aria-hidden="true" />
      </IconButton>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} labelledBy="appearance-title" placement="above-start" width={260}>
        <h3 id="appearance-title">Appearance</h3>
        <Segmented<Theme>
          label="Appearance"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </Popover>
    </>
  )
}

/** The floating ledger: project, stages as a live status board, local-only note. */
export function Sidebar() {
  const session = useSession().data
  const platform = useAppInfo().data?.platform
  const machine = thisMachine(platform)
  const step = useView((s) => s.step)
  const live = useLiveJob()
  // Review decisions show at once in the photo list and reach the session after a short batch;
  // the ledger reads the list so it never says "1 of 1 left" after the last call.
  const unsure = useCachedPhotos(['uncertain']).data
  const reviewPending = unsure?.filter((p) => p.review === 'pending').length
  const video = useVideoSettings() ?? undefined
  const rows = session ? deriveLedger(session, live, { reviewPending, video }) : []
  const currentId = ledgerIdForStep(step)
  return (
    <>
      {/* macOS vibrancy: paints the window opaque around the card so the material shows only inside it. */}
      <div className="sidebar-backdrop" aria-hidden="true" />
      <nav className="sidebar" aria-label="Project">
      <div className="sidebar-drag" data-tauri-drag-region />
      <ProjectHeader />
      <ol className="stages">
        {rows.map((row) => (
          <LedgerButton key={row.id} row={row} current={row.id === currentId} />
        ))}
      </ol>
      <ModelsNotice />
      <footer className="sidebar-foot">
        <span className="local-note">
          <HardDrives className="icon" aria-hidden="true" />
          <span>Nothing leaves {machine}</span>
        </span>
        <KeysHint />
        <AppearanceButton />
      </footer>
      </nav>
    </>
  )
}
