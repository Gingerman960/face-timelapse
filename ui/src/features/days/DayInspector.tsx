import type { KeyboardEvent } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { CalendarX, DotsSixVertical, Plus, Swap } from '@phosphor-icons/react'
import type { DayGroup, DayKey, FrameSummary, PhotoSummary } from '../../ipc/contract'
import { alignedUrl, thumbUrl } from '../../ipc/images'
import { RetryImg } from '../../components/ui/RetryImg'
import { addDays, formatDay, formatShortDate, isAfterMidnightHint, knownTime, weekdayOf } from '../../lib/dates'
import { EdgePrint } from '../../components/ui/EdgePrint'
import { DataText } from '../../components/ui/DataText'
import { LoopMark } from '../../components/ui/Mark'
import { useJustDecided } from './justDecided'
import { FaceThumb } from './DayCell'
import { useModelsBlock } from '../../state/models'
import { dayPhotos } from './daysModel'
import { formatCount } from '../../lib/format'

/** Days shown on each side of the selected day in "Around it" (five prints, large enough to judge: critique round 4). */
const AROUND_RADIUS = 2
/** "Around it" prints are about this wide (CSS px), for the image width bucket. */
const AROUND_PRINT_PX = 56

interface AltProps {
  photo: PhotoSummary
  index: number
  chosen: boolean
  /** The day is left out of the timelapse, so its chosen photo is too. */
  dayExcluded: boolean
  dayKey: DayKey
  base: string
  disabled: boolean
  onChoose: (id: string) => void
  onMove: (id: string, day: DayKey) => void
}

/** Where the chosen photo stands (M7): an excluded day takes its pick out with it. */
function chosenState(chosen: boolean, dayExcluded: boolean): string | null {
  if (!chosen) return null
  return dayExcluded ? 'Left out with the day' : 'In the timelapse'
}

/**
 * When the photo was taken, as its card says it: the time of day when it is
 * known (contract v1.4), else the date alone, never "00:00"; null for a photo
 * moved here by hand, whose own moment belongs to another day.
 */
function takenLabel(photo: PhotoSummary): string | null {
  if (photo.dateSource === 'manual') return null
  return knownTime(photo) ?? formatShortDate(photo.dayKey)
}

function altLabel(photo: PhotoSummary, state: string | null, afterMidnight: boolean): string {
  const taken = takenLabel(photo)
  return [taken ? `Photo taken ${taken}` : 'Photo', `likeness ${photo.score.toFixed(2)}`, afterMidnight && 'taken after midnight', state?.toLowerCase()].filter(Boolean).join(', ')
}

/**
 * One photo of the day, as a card: a radio (choose it for the timelapse)
 * that is also a pointer drag source, and, for a photo taken just after
 * midnight, a third line with a link that moves it to the day before (P2-8,
 * critique round 5 P2-19). The link sits inside the card but outside the
 * radio, so it stays its own button. Only dnd-kit's pointer listeners are attached: its keyboard
 * attributes would announce "press space to pick up" (no keyboard sensor
 * exists) and replace the radio role. The keyboard path is the screen's move
 * mode (M, arrows, Enter, Esc).
 */
function Alternate({ photo, index, chosen, dayExcluded, dayKey, base, disabled, onChoose, onMove }: AltProps) {
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: photo.id, data: { photoId: photo.id, from: dayKey }, disabled })
  const afterMidnight = photo.dateSource !== 'manual' && isAfterMidnightHint(photo)
  const prevDay = addDays(dayKey, -1)
  const state = chosenState(chosen, dayExcluded)
  // The loop is written with the pen only for the photo just picked (critique round 4).
  const justChosen = useJustDecided((s) => s.photo === photo.id)
  return (
    <div className="alt-card" data-chosen={chosen ? 'true' : undefined} style={{ opacity: isDragging ? 0.35 : 1 }}>
      {/* The radio is the whole card, laid over it: a click anywhere chooses, a drag anywhere moves. What the card
          shows is drawn beside it for the eye only (the radio's name says it all), so the after-midnight move can
          be the card's own third line and still its own button (critique round 5, P2-19). */}
      <button
        ref={setNodeRef}
        {...listeners}
        type="button"
        role="radio"
        aria-checked={chosen}
        className="alt"
        disabled={disabled}
        onClick={() => onChoose(photo.id)}
        aria-label={altLabel(photo, state, afterMidnight)}
      />
      <span className="alt-img" aria-hidden="true">
        <FaceThumb photo={photo} base={base} cellPx={64} />
        {/* The red loop marks the photo in the timelapse; a left-out day's pick isn't (critique round 2). */}
        {chosen && !dayExcluded ? <LoopMark draw={justChosen} /> : null}
      </span>
      <span className="alt-meta">
        <strong aria-hidden="true">{takenLabel(photo) ?? 'Moved here'}</strong>
        <span aria-hidden="true">
          <DataText>{`${photo.score.toFixed(2)} likeness`}</DataText>
        </span>
        {state ? (
          <span className={dayExcluded ? 'chosen-label out' : 'chosen-label'} aria-hidden="true">
            {state}
          </span>
        ) : null}
        {afterMidnight ? (
          <span className="alt-note">
            <span aria-hidden="true">{disabled ? 'Taken after midnight' : 'Taken after midnight · '}</span>
            {disabled ? null : (
              <button type="button" className="btn-text" aria-label={`Move to ${formatDay(prevDay)}`} onClick={() => onMove(photo.id, prevDay)}>
                Move to {formatShortDate(prevDay)}
              </button>
            )}
          </span>
        ) : null}
      </span>
      {index < 9 ? <kbd aria-hidden="true">{index + 1}</kbd> : <span />}
      <DotsSixVertical className="icon grip" aria-hidden="true" />
    </div>
  )
}

interface DayInspectorProps {
  dayKey: DayKey
  group: DayGroup | undefined
  photos: ReadonlyMap<string, PhotoSummary>
  byDay: ReadonlyMap<DayKey, DayGroup>
  /** Aligned frames by day, once aligned: "Around it" shows them as they will play. */
  frames?: ReadonlyMap<DayKey, FrameSummary>
  /** The output frame's aspect ("3 / 4"), for "Around it". */
  frameAspect?: string
  base: string
  busy: boolean
  onChoose: (id: string) => void
  onMove: (id: string, day: DayKey) => void
  onStartMove: () => void
  onToggleExcluded: () => void
  onAdd: () => void
  onSelectDay: (day: DayKey) => void
  /** A run of days is selected (critique round 6, P1-4): X and its row apply to the whole run. */
  run?: RunRow | null
}

/** The inspector's view of a run of days. */
export interface RunRow {
  /** "2–5 May 2014". */
  label: string
  /** Calendar days in the run, empty ones included. */
  days: number
  /** "Leave these 4 days out" / "Put these 4 days back in". */
  action: string
  /** Nothing to change, or the run's changes are still on their way. */
  disabled: boolean
  onToggle: () => void
}

/** The run's head: how many days, which, and how to change it. */
function RunHead({ run }: { run: RunRow }) {
  return (
    <section className="insp-section run-head" aria-label="Run of days">
      <h2 className="label-caps">{`${formatCount(run.days)} days`}</h2>
      <p className="run-dates">{run.label}</p>
      <p className="day-sub">⇧-click or ⇧←/⇧→ to change it · Esc ends it</p>
    </section>
  )
}

const RADIO_STEP: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }

/**
 * Arrows inside the photos move between the radios, choosing the next one
 * and keeping focus on it (UI review 2, M3), instead of reaching the screen's
 * day keys, which re-keyed the inspector and dropped focus to the body.
 */
function radioKeys(e: KeyboardEvent<HTMLDivElement>, list: readonly PhotoSummary[], onChoose: (id: string) => void, busy: boolean): void {
  const step = RADIO_STEP[e.key]
  const radio = (e.target as Element).closest('[role="radio"]')
  if (step === undefined || !radio || e.metaKey || e.ctrlKey || e.altKey) return
  e.preventDefault()
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')]
  const at = radios.indexOf(radio as HTMLElement)
  const next = (at + step + radios.length) % radios.length
  radios[next]?.focus()
  const photo = list[next]
  if (photo && !busy) onChoose(photo.id)
}

function summary(group: DayGroup | undefined): string {
  if (!group) return 'No photo'
  const n = group.photoIds.length
  const count = n === 1 ? '1 photo' : `${n} photos`
  if (group.excluded) return `${count} · left out of the timelapse`
  if (n === 1) return count
  return `${count} · ${group.manualSelection ? 'your pick' : 'best match chosen'}`
}

/** The selected day: its photos (drag one onto another day), actions, and the days around it. */
export function DayInspector({ dayKey, group, photos, byDay, frames, frameAspect, base, busy, onChoose, onMove, onStartMove, onToggleExcluded, onAdd, onSelectDay, run = null }: DayInspectorProps) {
  // Adding a photo finds its face: not without the models (QA).
  const models = useModelsBlock()
  const list = dayPhotos(group, photos)
  const around = Array.from({ length: AROUND_RADIUS * 2 + 1 }, (_, i) => addDays(dayKey, i - AROUND_RADIUS))
  return (
    <aside className="inspector" aria-label="Selected day">
      {run ? <RunHead run={run} /> : null}
      <section className="insp-section day-head">
        <h2 className="day-date">{formatDay(dayKey)}</h2>
        <p className="day-sub">
          {weekdayOf(dayKey)} · {summary(group)}
        </p>
      </section>
      {list.length > 0 ? (
        <section className="insp-section">
          <div className="alts" role="radiogroup" aria-label={`Photos on ${formatDay(dayKey)}`} onKeyDown={(e) => radioKeys(e, list, onChoose, busy)}>
            {list.map((p, i) => (
              <Alternate
                key={p.id}
                photo={p}
                index={i}
                chosen={p.id === group?.selectedId}
                dayExcluded={group?.excluded ?? false}
                dayKey={dayKey}
                base={base}
                disabled={busy}
                onChoose={onChoose}
                onMove={onMove}
              />
            ))}
          </div>
        </section>
      ) : (
        <section className="insp-section">
          <p className="day-sub">Nothing was taken on this day. Add a photo, or drag one here from a neighbouring day.</p>
        </section>
      )}
      <section className="insp-section">
        <div className="action-rows">
          <button type="button" className="row-btn" disabled={busy || list.length === 0} onClick={onStartMove}>
            <Swap className="icon" aria-hidden="true" />
            Move a photo to another day…
            <span />
            <kbd aria-hidden="true">M</kbd>
          </button>
          {run ? (
            <button type="button" className="row-btn" disabled={busy || run.disabled} onClick={run.onToggle}>
              <CalendarX className="icon" aria-hidden="true" />
              {run.action}
              <span />
              <kbd aria-hidden="true">X</kbd>
            </button>
          ) : (
            <button type="button" className="row-btn" disabled={busy || !group} onClick={onToggleExcluded} aria-pressed={group?.excluded ?? false}>
              <CalendarX className="icon" aria-hidden="true" />
              {group?.excluded ? 'Put this day back in' : 'Leave this day out'}
              <span />
              <kbd aria-hidden="true">X</kbd>
            </button>
          )}
          <button type="button" className="row-btn" disabled={busy || models !== null} title={models ?? undefined} onClick={onAdd}>
            <Plus className="icon" aria-hidden="true" />
            Add a photo to this day…
            <span />
            <span />
          </button>
        </div>
      </section>
      <section className="insp-section">
        <h2 className="label-caps">Around it</h2>
        <div className="neighbours" style={frameAspect ? { ['--frame-ar' as string]: frameAspect } : undefined}>
          {around.map((d) => {
            const g = byDay.get(d)
            const p = g ? photos.get(g.selectedId) : undefined
            const frame = frames?.get(d)
            const dpr = window.devicePixelRatio
            return (
              <button key={d} type="button" className={d === dayKey ? 'now' : undefined} aria-label={`${weekdayOf(d)} ${formatDay(d)}`} onClick={() => onSelectDay(d)}>
                <EdgePrint day={String(Number(d.slice(8, 10)))} />
                {frame ? (
                  <RetryImg className="print" src={alignedUrl(base, frame, AROUND_PRINT_PX, dpr)} alt="" loading="lazy" decoding="async" draggable={false} />
                ) : p ? (
                  <RetryImg className="print" src={thumbUrl(base, { id: p.id, version: p.version }, AROUND_PRINT_PX, dpr)} alt="" loading="lazy" decoding="async" draggable={false} />
                ) : null}
              </button>
            )
          })}
        </div>
      </section>
    </aside>
  )
}
