// ui/src/state/video.ts
// The video settings in effect (QA N4): one copy shared by the ledger, the
// player and the export sheet, so they always agree on the pace and length.
// An edit shows at once as a draft and is saved with `set_video_settings`
// (contract v1.5) after a short quiet spell; the saved settings then come
// back as the session's, and the draft goes away.
import type { SessionSnapshot, VideoSettings } from '../ipc/contract'
import { call, toIpcError } from '../ipc/client'
import { queryClient, queryKeys, useSession } from './queries'
import { scheduleVideoSave, useVideoDraft, videoGeneration } from './videoDraft'

/** Quiet spell after the last edit before the settings are saved (typing a pace, dragging through holds). */
export const VIDEO_SAVE_DELAY_MS = 400

/** The settings in effect: the draft being edited, else the session's (as last saved). */
export function effectiveVideo(session: VideoSettings, draft: VideoSettings | null): VideoSettings {
  return draft ?? session
}

/** The video settings in effect, or null before the session loads. */
export function useVideoSettings(): VideoSettings | null {
  const session = useSession().data
  const draft = useVideoDraft((s) => s.draft)
  return session ? effectiveVideo(session.video, draft) : null
}

/** The video settings in effect right now, outside React (e.g. ⌘↩ right after a field committed); null before the session loads. */
export function getVideoSettings(): VideoSettings | null {
  const session = queryClient.getQueryData<SessionSnapshot>(queryKeys.session)
  return session ? effectiveVideo(session.video, useVideoDraft.getState().draft) : null
}

let saveSeq = 0

/**
 * Saves `settings`; only the answer to the newest request lands, and only for
 * the session it was made in. Success makes them the session's own and drops
 * the draft (unless a newer edit came meanwhile); a refusal keeps the draft
 * on screen with the backend's message.
 */
async function saveVideoSettings(settings: VideoSettings, generation: number): Promise<void> {
  saveSeq += 1
  const seq = saveSeq
  const current = () => seq === saveSeq && generation === videoGeneration()
  try {
    const saved = await call('set_video_settings', { settings })
    if (!current()) return
    // A session read already in flight was answered before this save and would
    // bring the old settings back after the draft is gone (UI review 3, M2).
    // Write the saved settings, then read the session again: the refetch
    // replaces that read silently, so whoever awaits it (afterJob's fresh
    // session) gets the new read, never the snapshot from before it (UI
    // review 4, L1: a reverting cancel handed them that).
    const stale = queryClient.isFetching({ queryKey: queryKeys.session }) > 0
    queryClient.setQueryData<SessionSnapshot>(queryKeys.session, (prev) => (prev ? { ...prev, video: saved } : prev))
    useVideoDraft.setState((s) => (s.draft === settings ? { draft: null, error: null } : s))
    if (stale) void queryClient.invalidateQueries({ queryKey: queryKeys.session })
  } catch (error) {
    if (!current()) return
    useVideoDraft.setState((s) => (s.draft === settings ? { ...s, error: toIpcError(error) } : s))
  }
}

/** Changes the video settings everywhere (ledger, player, export sheet) at once, and saves them after a quiet spell. */
export function setVideoSettings(next: VideoSettings): void {
  useVideoDraft.setState({ draft: next, error: null })
  scheduleVideoSave((generation) => void saveVideoSettings(next, generation), VIDEO_SAVE_DELAY_MS)
}
