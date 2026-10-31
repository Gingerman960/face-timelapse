import { useEffect, useRef, useState } from 'react'
import {
  closestCenter,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  type Active,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Over,
} from '@dnd-kit/core'
import type { DayKey, PhotoId } from '../../ipc/contract'
import { formatDay } from '../../lib/dates'
import type { MovePhoto } from './useDayActions'

export interface DragPhoto {
  photoId: PhotoId
  from: DayKey
}

/** Pointer travel before a press becomes a drag, so a click still chooses the photo. */
const DRAG_THRESHOLD_PX = 5

function dragPhoto(active: Active | null): DragPhoto | null {
  return (active?.data.current as DragPhoto | undefined) ?? null
}

function dropDay(over: Over | null): DayKey | null {
  return (over?.data.current as { dayKey?: DayKey } | undefined)?.dayKey ?? null
}

/**
 * The drop target is the cell under the pointer (QA HIGH): dnd-kit's default
 * rectangle intersection matched the whole dragged row (about 272×85 px), so a
 * release over 13 Sep landed on 4 Sep. Without pointer coordinates (a keyboard
 * drag) the nearest cell centre is used instead.
 */
export const dropUnderPointer: CollisionDetection = (args) => (args.pointerCoordinates ? pointerWithin(args) : closestCenter(args))

/** What dnd-kit's live region says during a pointer drag (its defaults read out raw ids). */
export const DRAG_ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => {
    const photo = dragPhoto(active)
    return photo ? `Picked up the photo from ${formatDay(photo.from)}.` : undefined
  },
  onDragOver: ({ over }) => {
    const day = dropDay(over)
    return day ? `Over ${formatDay(day)}.` : undefined
  },
  onDragEnd: ({ active, over }) => {
    const day = dropDay(over)
    return day && day !== dragPhoto(active)?.from ? `Moving to ${formatDay(day)}.` : 'Nothing moved.'
  },
  onDragCancel: () => 'Move cancelled.',
}

/** The pointer drag layer: which photo is held, the day under it, and the DndContext handlers. */
export function useDayDrag(moveTo: MovePhoto) {
  const [drag, setDrag] = useState<DragPhoto | null>(null)
  const [overDay, setOverDay] = useState<DayKey | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_THRESHOLD_PX } }))
  // dnd-kit's document listeners outlive an unmount mid-drag (e.g. ⌘5); their late drop must not move anything.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const finish = () => {
    setDrag(null)
    setOverDay(null)
  }
  const handlers = {
    onDragStart: (e: DragStartEvent) => setDrag(dragPhoto(e.active)),
    onDragOver: (e: DragOverEvent) => setOverDay(dropDay(e.over)),
    onDragEnd: (e: DragEndEvent) => {
      const to = dropDay(e.over)
      if (mounted.current && drag && to) moveTo(drag.photoId, drag.from, to)
      finish()
    },
    // Esc mid-drag: clear the drop-target ring too (M18).
    onDragCancel: finish,
  }
  return { drag, overDay, sensors, handlers, collisionDetection: dropUnderPointer }
}
