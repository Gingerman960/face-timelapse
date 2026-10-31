import { ArrowCounterClockwise, CalendarDots, CalendarX } from '@phosphor-icons/react'
import type { FrameAdjust, FrameSummary } from '../../ipc/contract'
import { formatDay, weekdayOf } from '../../lib/dates'
import { NumberField } from '../../components/ui/Controls'

const IDENTITY: FrameAdjust = { dx: 0, dy: 0, scale: 1, rotationDeg: 0 }

/** Parses a user-typed number, clamped to [min, max]; null if not a number. */
export function parseClamped(raw: string, min: number, max: number): number | null {
  const v = Number(raw.replace(',', '.').replace('−', '-'))
  if (!Number.isFinite(v)) return null
  return Math.min(max, Math.max(min, v))
}

interface FrameInspectorProps {
  frame: FrameSummary
  busy: boolean
  /** Why a nudge can't be rendered (the face models are missing), or null. */
  blocked?: string | null
  /** A nudge: the changed fields only, merged into the newest adjust asked for (UI review 2, H3). */
  onAdjust: (patch: Partial<FrameAdjust>) => void
  onReplace: () => void
  onExclude: () => void
}

interface NudgeSpec {
  key: keyof FrameAdjust
  title: string
  label: string
  unit: string
  min: number
  max: number
  /** Field units per adjust unit (percent of the frame, or degrees). */
  scale: number
  digits: number
}

const NUDGES: readonly NudgeSpec[] = [
  { key: 'dx', title: 'Across', label: 'Move across, percent of the width', unit: '%', min: -25, max: 25, scale: 100, digits: 1 },
  { key: 'dy', title: 'Down', label: 'Move down, percent of the height', unit: '%', min: -25, max: 25, scale: 100, digits: 1 },
  { key: 'scale', title: 'Scale', label: 'Scale, percent', unit: '%', min: 50, max: 200, scale: 100, digits: 0 },
  { key: 'rotationDeg', title: 'Rotate', label: 'Rotate, degrees', unit: '°', min: -20, max: 20, scale: 1, digits: 1 },
]

/** Per-frame nudge (dx, dy, scale, rotation) re-rendered by the backend, plus day actions. */
export function FrameInspector({ frame, busy, blocked = null, onAdjust, onReplace, onExclude }: FrameInspectorProps) {
  const noNudge = busy || blocked !== null
  const a = frame.adjust
  const nudged = a.dx !== 0 || a.dy !== 0 || a.scale !== 1 || a.rotationDeg !== 0
  const commit = (n: NudgeSpec) => (raw: string) => {
    const v = parseClamped(raw, n.min, n.max)
    if (v === null) return false
    onAdjust({ [n.key]: v / n.scale })
  }
  return (
    <aside className="inspector" aria-label="Frame">
      <section className="insp-section day-head">
        <h2 className="day-date">{formatDay(frame.dayKey)}</h2>
        <p className="day-sub">
          {weekdayOf(frame.dayKey)} · fit {frame.residualPx.toFixed(1)} px
        </p>
      </section>
      <section className="insp-section">
        <h2 className="label-caps">Nudge</h2>
        {blocked ? <p className="nudge-off">{blocked}</p> : null}
        <div className="nudge-grid">
          {NUDGES.map((n) => (
            <div key={n.key} className="nudge-field">
              <span aria-hidden="true">{n.title}</span>
              <NumberField label={n.label} value={(a[n.key] * n.scale).toFixed(n.digits)} unit={n.unit} disabled={noNudge} onCommit={commit(n)} />
            </div>
          ))}
        </div>
      </section>
      <section className="insp-section">
        <div className="action-rows">
          <button type="button" className="row-btn" disabled={noNudge || !nudged} title={blocked ?? undefined} onClick={() => onAdjust(IDENTITY)}>
            <ArrowCounterClockwise className="icon" aria-hidden="true" />
            Reset the nudge
            <span />
            <span />
          </button>
          <button type="button" className="row-btn" onClick={onReplace}>
            <CalendarDots className="icon" aria-hidden="true" />
            Use another photo for this day…
            <span />
            <span />
          </button>
          <button type="button" className="row-btn" disabled={busy} onClick={onExclude}>
            <CalendarX className="icon" aria-hidden="true" />
            Leave this day out
            <span />
            <span />
          </button>
        </div>
      </section>
    </aside>
  )
}
