// How backend errors read in the UI (contract v1.3 behaviour).
import type { IpcError } from './contract'

/** Where a path came into play: decides what a refusal should suggest instead. */
export type PathContext = 'reference' | 'folder' | 'addPhoto' | 'export' | 'reveal' | 'open'

/**
 * v1.3 path grants: the backend only uses files and folders the user chose
 * (a dialog, a drop onto the window, or the session's own paths). Its
 * not-granted message is generic, so each place says how to choose instead.
 */
const NOT_GRANTED: Record<PathContext, string> = {
  reference: 'FaceTimelapse can only open a photo you choose. Use Choose photo… or drop it onto the window.',
  folder: 'FaceTimelapse can only read a folder you choose. Use Choose folder… or drop it onto the window.',
  addPhoto: 'FaceTimelapse can only add a photo you choose. Use Add a photo to this day… to pick it.',
  export: 'FaceTimelapse saves only where you choose. Use Export… and choose where to save it again.',
  reveal: 'That file isn’t one FaceTimelapse saved, so it can’t be shown in its folder.',
  open: 'That file isn’t a video FaceTimelapse saved, so it can’t be opened from here.',
}

/**
 * An OS-level refusal (macOS privacy settings) carries actionable advice from
 * the backend ("Grant access in System Settings…"); keep that one as it is.
 */
function isSystemPermission(error: IpcError): boolean {
  return /System Settings|Privacy|Settings/i.test(error.message)
}

/** The error with a message fit for this place in the UI. */
export function inContext(error: IpcError, context: PathContext): IpcError {
  if (error.kind !== 'permissionDenied' || isSystemPermission(error)) return error
  return { kind: error.kind, message: NOT_GRANTED[context] }
}

/**
 * `cancelled` from a command (contract v1.3) means different things per
 * command (UI review 2, M4): a folder pick or set superseded by a newer
 * choice (nothing to show), or a photo whose folder changed while it was read
 * (its message says to add it again). Each call site decides; nothing is
 * silenced globally.
 */
export function isCancelled(error: IpcError): boolean {
  return error.kind === 'cancelled'
}
