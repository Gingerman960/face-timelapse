import { memo, type KeyboardEvent } from 'react'
import { useDroppable } from '@dnd-kit/core'
import type { DayGroup, DayKey, FrameSummary, PhotoSummary } from '../../ipc/contract'
import { thumbUrl } from '../../ipc/images'
import { formatDayLong, weekdayOf } from '../../lib/dates'
import { LoopMark } from '../../components/ui/Mark'
import { RetryImg } from '../../components/ui/RetryImg'
import { faceCellStyle } from './daysModel'
import { TransitionPrint } from './TransitionPrint'

/** Alternates fanned out behind a month-zoom face (DESIGN: "alternates fanned out"). */
const FAN_MAX = 2
/** Fanned cards are mostly covered: any width asks for the smallest thumbnail bucket. */
const FAN_THUMB_CSS_PX = 1
/** The most a face crop magnifies its thumbnail (a small face in a wide photo). */
const MAX_FACE_ZOOM = 6
const FACE_SPAN = 2.1

interface FaceThumbProps {
  photo: PhotoSummary
  base: string
  /** Approximate rendered cell size in CSS px (picks the width bucket). */
  cellPx: number
}

/** The thumbnail width (CSS px) that a face-centred crop `cellPx` wide needs. */
function thumbCssPx(photo: PhotoSummary, cellPx: number): number {
  const face = photo.faceBox
  if (!face) return cellPx
  return cellPx * Math.min(MAX_FACE_ZOOM, 1 / Math.max(0.15, Math.max(face.width, face.height) * FACE_SPAN))
}

/** A face-centred square crop of a photo's full thumbnail; a failed load retries (QA 1). */
export const FaceThumb = memo(function FaceThumb({ photo, base, cellPx }: FaceThumbProps) {
  const src = thumbUrl(base, { id: photo.id, version: photo.version }, thumbCssPx(photo, cellPx), window.devicePixelRatio)
  return (
    <span className="face">
      <RetryImg src={src} alt="" style={faceCellStyle(photo.faceBox, photo.size)} loading="lazy" decoding="async" draggable={false} />
    </span>
  )
})

/** The day's other photos, best first, at most FAN_MAX. */
function fanPhotos(group: DayGroup, photos: ReadonlyMap<string, PhotoSummary>): PhotoSummary[] {
  return group.photoIds
    .filter((id) => id !== group.selectedId)
    .slice(0, FAN_MAX)
    .map((id) => photos.get(id))
    .filter((p): p is PhotoSummary => p !== undefined)
}

/**
 * Month zoom: the day's alternates as prints fanned out behind its chosen
 * face. Absolutely placed and turned with transforms, so they cost no
 * layout; decorative (the cell's label already counts the photos).
 */
function Fan({ group, photos, base }: { group: DayGroup; photos: ReadonlyMap<string, PhotoSummary>; base: string }) {
  return fanPhotos(group, photos).map((p, i) => (
    <span key={p.id} className="fan-card" data-fan={i} aria-hidden="true">
      <FaceThumb photo={p} base={base} cellPx={FAN_THUMB_CSS_PX} />
    </span>
  ))
}

interface DayCellProps {
  dayKey: DayKey
  group: DayGroup | undefined
  photo: PhotoSummary | undefined
  /** The day's aligned frame, given to the selected day only: the print a screen change carries into the player. */
  frame?: FrameSummary
  base: string
  cellPx: number
  selected: boolean
  /** Inside the run of days (⇧-click, ⇧←/⇧→): selected with the active day. */
  inRun?: boolean
  /** The day the user just picked a photo for: its underline is written with the pen. */
  just?: boolean
  /** The grid's one Tab stop (roving tabindex). */
  focusable: boolean
  inRange: boolean
  /** Drop target highlight / drag source dimming (dnd-kit state). */
  source?: boolean
  target?: boolean
  showNumber?: boolean
  /** Month zoom: the photos to fan the day's alternates out from. */
  fanFrom?: ReadonlyMap<string, PhotoSummary>
  /** `extend`: ⇧-click or ⇧Space, the run of days reaches this day. */
  onSelect: (day: DayKey, extend?: boolean) => void
}

/** "Friday 2 May 2014, 3 photos, your pick" (DESIGN, Accessibility). */
export function cellLabel(dayKey: DayKey, group: DayGroup | undefined): string {
  const date = `${weekdayOf(dayKey)} ${formatDayLong(dayKey)}`
  if (!group) return `${date}, no photo`
  const parts = [date, group.photoIds.length > 1 ? `${group.photoIds.length} photos` : '1 photo']
  if (group.manualSelection) parts.push('your pick')
  if (group.excluded) parts.push('left out')
  return parts.join(', ')
}

/** A grid position without a day of the library (before the 1st, or outside the range). */
export function BlankCell({ outOfRange = false }: { outOfRange?: boolean }) {
  return <div role="gridcell" className={outOfRange ? 'day out-of-range' : 'day pad'} />
}

/**
 * One calendar day: a grid cell showing its photo (face-cropped), or an empty
 * numbered cell. Focus follows the selection; it is also a drop target.
 */
export const DayCell = memo(function DayCell({ dayKey, group, photo, frame, base, cellPx, selected, inRun, just, focusable, inRange, source, target, showNumber, fanFrom, onSelect }: DayCellProps) {
  const { setNodeRef, isOver } = useDroppable({ id: dayKey, data: { dayKey }, disabled: !inRange })
  if (!inRange) return <BlankCell outOfRange />
  const day = Number(dayKey.slice(8, 10))
  const alts = group !== undefined && group.photoIds.length > 1
  const fanned = alts && photo !== undefined && fanFrom !== undefined
  const cls = ['day', !group && 'empty', alts && 'has-alts', fanned && 'fanned', group?.manualSelection && 'mine', group?.excluded && 'excluded']
    .filter(Boolean)
    .join(' ')
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Space would scroll the calendar; Enter is left to the screen (it commits a keyboard move).
    if (e.key !== ' ') return
    e.preventDefault()
    onSelect(dayKey, e.shiftKey)
  }
  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      className={cls}
      data-day={dayKey}
      data-over={isOver || target ? 'true' : undefined}
      data-source={source ? 'true' : undefined}
      data-just={just ? 'true' : undefined}
      data-run={inRun ? 'true' : undefined}
      aria-label={cellLabel(dayKey, group)}
      aria-selected={selected || inRun === true}
      tabIndex={focusable ? 0 : -1}
      onClick={(e) => onSelect(dayKey, e.shiftKey)}
      onKeyDown={onKeyDown}
    >
      {fanned ? <Fan group={group} photos={fanFrom} base={base} /> : null}
      {photo ? <FaceThumb photo={photo} base={base} cellPx={cellPx} /> : null}
      {selected && frame ? <TransitionPrint frame={frame} base={base} cellPx={cellPx} /> : null}
      {!group || showNumber ? <span className="day-num">{day}</span> : null}
      {/* Generated content: the cell's name already counts the photos, and its visible text stays the day number. */}
      {showNumber && alts ? <span className="alt-count" data-count={group.photoIds.length} aria-hidden="true" /> : null}
      {selected ? <LoopMark neutral /> : null}
    </div>
  )
})
