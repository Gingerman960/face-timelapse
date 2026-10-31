import { useCallback } from 'react'
import type { DayGroup, DayKey, PhotoId } from '../../ipc/contract'
import { addPhotoToDay, movePhotoToDay, reportError, selectDayPhoto, setDayExcluded } from '../../state/actions'
import { useView } from '../../state/view'
import { movedMessage } from './daysModel'
import { useJustDecided } from './justDecided'

export type MovePhoto = (photoId: PhotoId, from: DayKey, to: DayKey) => void

export interface DayActions {
  /** Moves a photo to another day, then offers Undo. */
  moveTo: MovePhoto
  /** Puts one of the day's photos in the timelapse. */
  choose: (photoId: PhotoId) => void
  toggleExcluded: () => void
  /** Adds a photo picked from disk to the day. */
  add: () => void
}

/** Edits of the selected day; each refusal is a toast, and nothing runs while another task is busy. */
export function useDayActions(day: DayKey, group: DayGroup | undefined, busy: boolean, select: (day: DayKey) => void): DayActions {
  const moveTo = useCallback<MovePhoto>(
    (photoId, from, to) => {
      if (from === to) return
      const undo = () =>
        void movePhotoToDay(photoId, from)
          .then(() => select(from))
          .catch(reportError)
      void movePhotoToDay(photoId, to)
        .then((patch) => {
          select(to)
          useView.getState().pushToast({ message: movedMessage(patch, photoId, to), tone: 'info', action: { label: 'Undo', run: undo } })
        })
        .catch(reportError)
    },
    [select],
  )
  return {
    moveTo,
    choose: (photoId) => {
      if (!group || busy) return
      if (photoId !== group.selectedId) useJustDecided.getState().mark(day, photoId)
      void selectDayPhoto(day, photoId).catch(reportError)
    },
    toggleExcluded: () => {
      if (group && !busy) void setDayExcluded(day, !group.excluded).catch(reportError)
    },
    add: () => {
      if (!busy) void addPhotoToDay(day, null).catch(reportError)
    },
  }
}
