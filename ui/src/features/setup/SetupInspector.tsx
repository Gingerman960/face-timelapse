import { useRef, useState, type KeyboardEvent } from 'react'
import { ArrowClockwise, ArrowCounterClockwise, Crosshair, DotsThree, FolderSimple } from '@phosphor-icons/react'
import type { AspectPreset, DayGroup, FolderInfo, ReferenceState, SessionSnapshot } from '../../ipc/contract'
import { aspectRatioOf } from '../../lib/crop'
import { formatCount } from '../../lib/format'
import { Facts } from '../../components/ui/Controls'
import { Notice, Popover } from '../../components/ui/Overlays'
import { IconButton, QuietButton, StopButton } from '../../components/ui/Button'
import { levelRotation } from './setupModel'
import { usePathDisplay } from '../../hooks/usePathDisplay'
import { residualTilt } from '../shell/ledger'

export const ASPECTS: AspectPreset[] = ['1:1', '3:4', '4:5', '9:16', '4:3', '16:9', 'free']

function glyphSize(aspect: AspectPreset): { width: number; height: number } {
  const r = aspectRatioOf(aspect)
  if (r === null) return { width: 30, height: 24 }
  return r >= 1 ? { width: 34, height: Math.round(34 / r) } : { width: Math.round(28 * r), height: 28 }
}

interface AspectTilesProps {
  value: AspectPreset
  disabled: boolean
  onChange: (aspect: AspectPreset) => void
}

/** Output framing presets drawn at their real proportions (radio group, arrow keys). */
export function AspectTiles({ value, disabled, onChange }: AspectTilesProps) {
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = ASPECTS.indexOf(value)
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!delta) return
    e.preventDefault()
    e.stopPropagation()
    const next = ASPECTS[(i + delta + ASPECTS.length) % ASPECTS.length]
    if (next) onChange(next)
  }
  return (
    <div className="aspects" role="radiogroup" aria-label="Output aspect ratio" onKeyDown={onKey}>
      {ASPECTS.map((a) => (
        <button
          key={a}
          type="button"
          role="radio"
          aria-checked={a === value}
          tabIndex={a === value ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(a)}
        >
          <i className={a === 'free' ? 'free' : undefined} style={glyphSize(a)} aria-hidden="true" />
          <span>{a === 'free' ? 'Free' : a}</span>
        </button>
      ))}
    </div>
  )
}

interface FaceActionsProps {
  reference: ReferenceState
  disabled: boolean
  onLevel: () => void
  onCenter: () => void
  onReset: () => void
}

/** Level the eyes (L), centre the face (C), reset the crop (R). */
export function FaceActions({ reference, disabled, onLevel, onCenter, onReset }: FaceActionsProps) {
  // The turn Level would make: the tilt left at the current rotation.
  const turn = residualTilt(reference.image.rotationDeg, reference.image.autoRotationDeg)
  const needsLevel = levelRotation(reference.image) !== null
  return (
    <div className="action-rows">
      <button type="button" className="row-btn" disabled={disabled || !needsLevel} onClick={onLevel} title={needsLevel ? undefined : 'The eyes are already level'}>
        <ArrowClockwise className="icon" aria-hidden="true" />
        Level the eyes
        <span className="mono-meta">{turn === null ? '—' : `${turn > 0.05 ? '+' : turn < -0.05 ? '−' : ''}${Math.abs(turn).toFixed(1)}°`}</span>
        <kbd aria-hidden="true">L</kbd>
      </button>
      <button type="button" className="row-btn" disabled={disabled || !reference.image.face} onClick={onCenter}>
        <Crosshair className="icon" aria-hidden="true" />
        Centre the face
        <span />
        <kbd aria-hidden="true">C</kbd>
      </button>
      <button type="button" className="row-btn" disabled={disabled} onClick={onReset}>
        <ArrowCounterClockwise className="icon" aria-hidden="true" />
        Reset crop
        <span />
        <kbd aria-hidden="true">R</kbd>
      </button>
    </div>
  )
}

/** Where the library's scan stands, for the inspector (critique round 4, P2-11 and P2-20). */
export interface ScanStanding {
  status: SessionSnapshot['scan']['status']
  /** Why the last scan failed (the job's error), or null. */
  error: string | null
  /** Scans the whole library again, when the plate has moved on to Review or Days; null otherwise. */
  again: (() => void) | null
  /** Why a scan can't start now, or null. */
  blocked: string | null
}

interface LibraryProps {
  folder: FolderInfo | null
  days: DayGroup[] | undefined
  disabled: boolean
  onChoose: () => void
  onForget: () => Promise<void>
  scanState?: ScanStanding
}

/**
 * A scan that stopped or failed stays said under the library facts, not only in a 4 s toast:
 * "Stopped at 2,231 of 3,593. The next scan continues from here." (critique round 4, P2-20).
 */
function ScanStopped({ folder, scanState }: { folder: FolderInfo; scanState: ScanStanding }) {
  const where = `Stopped at ${formatCount(folder.analyzedCount)} of ${formatCount(folder.imageCount)}.`
  if (scanState.error) {
    return (
      <Notice tone="stop" title="The scan stopped.">
        {scanState.error} {scanState.status === 'partial' ? `${where} The next scan continues from here.` : null}
      </Notice>
    )
  }
  if (scanState.status !== 'partial') return null
  return (
    <Notice tone="safelight" title={where}>
      The next scan continues from here.
    </Notice>
  )
}

/** The library folder card, its facts, and "Forget earlier scan results…". */
export function LibrarySection({ folder, days, disabled, onChoose, onForget, scanState }: LibraryProps) {
  const showPath = usePathDisplay()
  const [confirm, setConfirm] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  if (!folder) {
    return (
      <div className="action-rows">
        <QuietButton icon={<FolderSimple className="icon" aria-hidden="true" />} kbd="⇧⌘O" onClick={onChoose} disabled={disabled}>
          Choose folder…
        </QuietButton>
      </div>
    )
  }
  const first = days?.[0]?.dayKey
  const last = days?.[days.length - 1]?.dayKey
  const toRead = Math.max(0, folder.imageCount - folder.analyzedCount)
  const rows = [
    { label: 'Photos', value: formatCount(folder.imageCount) },
    { label: 'Already read', value: formatCount(folder.analyzedCount) },
    { label: 'Still to read', value: formatCount(toRead) },
    ...(folder.unsupportedCount > 0 ? [{ label: 'HEIC, skipped', value: formatCount(folder.unsupportedCount) }] : []),
    ...(first && last ? [{ label: 'Dates', value: `${shortMonth(first)} – ${shortMonth(last)}` }] : []),
  ]
  return (
    <>
      <div className="lib-card">
        <FolderSimple className="icon" aria-hidden="true" />
        <div>
          <strong>{folder.name}</strong>
          <span className="mono-meta path" title={folder.path}>
            {showPath(folder.path, 32)}
          </span>
        </div>
        <IconButton small label="Choose another folder" onClick={onChoose} disabled={disabled}>
          <DotsThree className="icon" aria-hidden="true" />
        </IconButton>
      </div>
      <Facts rows={rows} />
      {scanState ? <ScanStopped folder={folder} scanState={scanState} /> : null}
      {scanState?.again ? (
        <div className="action-rows">
          {/* A row of the inspector, not a second primary (critique round 5, P3-21). */}
          <button type="button" className="row-btn" onClick={scanState.again} disabled={disabled || scanState.blocked !== null} title={scanState.blocked ?? undefined}>
            <ArrowClockwise className="icon" aria-hidden="true" />
            Scan again
          </button>
        </div>
      ) : null}
      <button
        ref={anchor}
        type="button"
        className="btn-text"
        aria-expanded={confirm}
        onClick={() => setConfirm(true)}
        disabled={disabled || folder.analyzedCount === 0}
      >
        Forget earlier scan results…
      </button>
      <Popover anchor={anchor} open={confirm} onClose={() => setConfirm(false)} labelledBy="forget-title" placement="above-start">
        <h3 id="forget-title">Forget earlier scan results?</h3>
        <p>The next scan reads all {formatCount(folder.imageCount)} photos again. Your review decisions and day picks are kept.</p>
        <div className="row end">
          <QuietButton onClick={() => setConfirm(false)}>Keep them</QuietButton>
          <StopButton
            onClick={() => {
              setConfirm(false)
              void onForget()
            }}
          >
            Forget
          </StopButton>
        </div>
      </Popover>
    </>
  )
}

interface ReferenceInspectorProps {
  reference: ReferenceState
  folder: FolderInfo | null
  days: DayGroup[] | undefined
  busy: boolean
  onAspect: (aspect: AspectPreset) => void
  onLevel: () => void
  onCenter: () => void
  onReset: () => void
  onChooseFolder: () => void
  onForget: () => Promise<void>
  scanState?: ScanStanding
}

/** The Reference inspector: framing, face actions and the library. */
export function ReferenceInspector({ reference, folder, days, busy, onAspect, onLevel, onCenter, onReset, onChooseFolder, onForget, scanState }: ReferenceInspectorProps) {
  return (
    <aside className="inspector" aria-label="Reference settings">
      <section className="insp-section">
        <h2 className="label-caps">Framing</h2>
        <AspectTiles value={reference.aspect} disabled={busy} onChange={onAspect} />
      </section>
      <section className="insp-section">
        <h2 className="label-caps">Face</h2>
        <FaceActions reference={reference} disabled={busy} onLevel={onLevel} onCenter={onCenter} onReset={onReset} />
      </section>
      <section className="insp-section">
        <h2 className="label-caps">Library</h2>
        <LibrarySection folder={folder} days={days} disabled={busy} onChoose={onChooseFolder} onForget={onForget} scanState={scanState} />
      </section>
      {folder ? (
        <p className="insp-note">
          Photos already read are remembered, even if you change the reference. You can keep working while a scan runs.
        </p>
      ) : null}
    </aside>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function shortMonth(dayKey: string): string {
  return `${MONTHS[Number(dayKey.slice(5, 7)) - 1] ?? ''} ${dayKey.slice(0, 4)}`
}
