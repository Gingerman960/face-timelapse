// The pick just made (critique round 4, P1-5): the pen writes only the mark of
// the decision the user just made — the day cell's chinagraph underline and the
// loop around the chosen photo in the inspector — never the marks that were
// already there. The note fades after a moment, so a remount never redraws.
import { create } from 'zustand'
import type { DayKey, PhotoId } from '../../ipc/contract'

/** How long a pick counts as "just made": the pen's stroke plus a backend round trip. */
export const JUST_DECIDED_MS = 900

interface JustDecided {
  day: DayKey | null
  photo: PhotoId | null
  /** Notes a pick; it stops counting as just made after JUST_DECIDED_MS. */
  mark: (day: DayKey, photo: PhotoId) => void
}

let timer: ReturnType<typeof setTimeout> | null = null

export const useJustDecided = create<JustDecided>((set) => ({
  day: null,
  photo: null,
  mark: (day, photo) => {
    if (timer) clearTimeout(timer)
    set({ day, photo })
    timer = setTimeout(() => {
      timer = null
      set({ day: null, photo: null })
    }, JUST_DECIDED_MS)
  },
}))
