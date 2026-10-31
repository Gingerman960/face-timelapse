// Commands for frames, the look, export dialogs, reveal_path, open_path and the saved video settings.
import { MESSAGES, invalid, ipcError, notFoundPath } from './errors'
import { fingerprintOf, frameSummaryOf, framesOf, framesViewOf } from './frames'
import { CANNED_DIALOGS, baseName, normalizePath, parentDir, videoPathFor } from './mockFs'
import type { Handler } from './setupCommands'
import { IDENTITY_ADJUST, type MockState, omitKey, sameAdjust, updateDecisions } from './state'
import { frameAdjust, lookSettings, str } from './validate'
import { videoSettings } from './videoPlan'

function isOutput(state: MockState, path: string): boolean {
  if (state.outputs.includes(path)) return true
  return state.exported[parentDir(path)]?.includes(baseName(path)) ?? false
}

export const frameHandlers = {
  get_frames: ({ state }) => ({ result: framesViewOf(state) }),

  set_frame_adjustment: ({ state }, args) => {
    const photoId = str(args, 'photoId')
    const adjust = frameAdjust(args)
    const fingerprint = fingerprintOf(state)
    const active = framesOf(state).active.find((a) => a.photoId === photoId)
    if (!fingerprint || !active?.record) throw ipcError('notFound', 'That photo has no aligned frame yet.')
    const record = { ...active.record, adjust }
    const withAdjust = updateDecisions(state, (d) => ({
      ...d,
      adjusts: sameAdjust(adjust, IDENTITY_ADJUST) ? omitKey(d.adjusts, photoId) : { ...d.adjusts, [photoId]: adjust },
    }))
    const next: MockState = {
      ...withAdjust,
      frames: { ...withAdjust.frames, [fingerprint]: { ...withAdjust.frames[fingerprint], [photoId]: record } },
    }
    return { state: next, result: frameSummaryOf(next, fingerprint, active.day, active.fixture, record) }
  },

  set_look: ({ state }, args) => {
    const next: MockState = { ...state, look: lookSettings(args) }
    return { state: next, result: framesViewOf(next) }
  },

  pick_export_folder: ({ options }) => ({ result: options.cancelDialogs ? null : CANNED_DIALOGS.exportFolder }),

  pick_video_path: ({ options }, args) => {
    const suggestedName = str(args, 'suggestedName')
    return { result: options.cancelDialogs ? null : videoPathFor(suggestedName) }
  },

  reveal_path: ({ state }, args) => {
    const raw = str(args, 'path')
    if (!raw.startsWith('/')) throw invalid('Use an absolute path.')
    const path = normalizePath(raw)
    if (isOutput(state, path)) return { result: null }
    if (state.discarded.includes(path)) throw notFoundPath(path)
    throw invalid('FaceTimelapse can only show files it exported in this session.')
  },

  // v1.7: opens a finished exported video in its default app (here: nothing to
  // open). Only `.mp4` outputs; every refusal is the same `notFound`.
  open_path: ({ state }, args) => {
    const path = str(args, 'path')
    if (path.toLowerCase().endsWith('.mp4') && state.outputs.includes(path)) return { result: null }
    throw ipcError('notFound', MESSAGES.notOpenable)
  },

  // v1.5: saves session.video without exporting (allowed while a job runs).
  set_video_settings: ({ state }, args) => {
    const video = videoSettings(args)
    return { state: { ...state, video }, result: video }
  },
} satisfies {
  [K in
    | 'get_frames'
    | 'set_frame_adjustment'
    | 'set_look'
    | 'pick_export_folder'
    | 'pick_video_path'
    | 'reveal_path'
    | 'open_path'
    | 'set_video_settings']: Handler<K>
}
