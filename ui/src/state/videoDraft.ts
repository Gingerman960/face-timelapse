// ui/src/state/videoDraft.ts
// The video settings being edited (pace, blend, holds, caption, size,
// quality) before the backend has saved them (contract v1.5
// `set_video_settings`). Kept free of the query cache, so a library or
// session replacement can drop it from anywhere without an import cycle.
import { create } from 'zustand'
import type { IpcError, VideoSettings } from '../ipc/contract'

export interface VideoDraftState {
  /** Settings edited and not yet confirmed by the backend, or null when the session's are in effect. */
  draft: VideoSettings | null
  /** Why the backend refused the draft (`invalidArgument`, the export's own message), shown inline. */
  error: IpcError | null
}

export const useVideoDraft = create<VideoDraftState>(() => ({ draft: null, error: null }))

let saveTimer: ReturnType<typeof setTimeout> | undefined
/** Bumped whenever the session is replaced: a save scheduled or answered for an older one never lands. */
let generation = 0

/** The current session generation. */
export function videoGeneration(): number {
  return generation
}

/** Runs `save` after `delayMs` of quiet (each call restarts the wait), for this session generation only. */
export function scheduleVideoSave(save: (generation: number) => void, delayMs: number): void {
  clearTimeout(saveTimer)
  const at = generation
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    save(at)
  }, delayMs)
}

/**
 * Forgets the draft, its error and any save still waiting (UI review 2, L8):
 * after another library, Start over or a backend session change, an old
 * draft must never re-apply to the new session, even one with equal settings.
 */
export function resetVideoDraft(): void {
  clearTimeout(saveTimer)
  saveTimer = undefined
  generation += 1
  useVideoDraft.setState({ draft: null, error: null })
}
