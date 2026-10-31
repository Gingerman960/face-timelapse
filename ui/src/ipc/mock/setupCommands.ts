// Commands for the app, the session, the reference photo and the source folder.
import type { AppInfo, CommandMap, CommandName, FolderInfo, IpcError, ReferenceState } from '../contract'
import { MESSAGES, decodeFailed, invalid, ipcError, notFoundPath } from './errors'
import { MOCK_IMAGE_BASE } from './imageRoutes'
import { CANNED_DIALOGS, baseName, classifyPath, normalizePath } from './mockFs'
import type { MockOptions } from './options'
import { MAX_ROTATION_DEG, cropError, cropReference, newReference, referenceStateOf, rotateReference } from './reference'
import { folderInfoOf, snapshotOf } from './session'
import {
  EMPTY_DECISIONS,
  EMPTY_SCAN,
  type FolderState,
  type MockState,
  currentFolder,
  freshState,
  newFolderState,
  pushRecent,
  withFolder,
} from './state'
import { type Args, absolutePath, aspect, cacheScope, num, rect } from './validate'
import type { ReferenceVariant } from './versions'

export interface HandlerContext {
  readonly state: MockState
  readonly options: MockOptions
}

export interface Outcome<R> {
  readonly state?: MockState
  readonly result: R
}

export type Handler<K extends CommandName> = (ctx: HandlerContext, args: Args) => Outcome<CommandMap[K]['result']>

export const APP_INFO: AppInfo = {
  version: '2.0.0',
  platform: 'macos',
  imageBaseUrl: MOCK_IMAGE_BASE,
  modelsReady: true,
  modelsError: null,
  parallelism: 12,
  dataDir: '/Users/demo/Library/Application Support/io.github.gingerman960.facetimelapse',
  cacheDir: '/Users/demo/Library/Caches/io.github.gingerman960.facetimelapse',
}

/** Analysis + thumbnails per cached file (≈ 3 MB + 90 MB for 3,593 photos). */
const CACHE_BYTES_PER_ENTRY = 26_000

function unsupported(extension: string): IpcError {
  return ipcError('unsupportedFormat', `FaceTimelapse can't read .${extension} files. Use JPEG, PNG, TIFF or WebP photos.`)
}

/** Resolves a reference candidate or throws the matching IpcError. */
function referenceVariantFor(path: string): ReferenceVariant {
  const kind = classifyPath(path)
  switch (kind.kind) {
    case 'relative':
      throw invalid('Use an absolute path.')
    case 'heic':
      throw ipcError('unsupportedFormat')
    case 'otherFile':
      throw unsupported(kind.extension)
    case 'missing':
      throw notFoundPath(path)
    case 'directory':
      throw invalid("That's a folder. Choose a photo of your face.")
    case 'image':
      if (kind.broken) throw decodeFailed(baseName(path))
      return kind.noFace ? 'noFace' : 'portrait'
  }
}

function setReference(state: MockState, rawPath: string): Outcome<ReferenceState> {
  const path = normalizePath(rawPath)
  const reference = newReference(path, referenceVariantFor(path))
  const recents = { ...state.recents, references: pushRecent(state.recents.references, path) }
  return { state: { ...state, reference, recents }, result: referenceStateOf(reference) }
}

function setFolder(state: MockState, rawPath: string): Outcome<FolderInfo> {
  const path = normalizePath(rawPath)
  const kind = classifyPath(path)
  if (kind.kind === 'relative') throw invalid('Use an absolute path.')
  if (kind.kind === 'missing') throw notFoundPath(path)
  if (kind.kind !== 'directory') throw invalid("That's a file, not a folder. Choose the folder that holds your daily photos.")
  if (kind.locked) throw ipcError('permissionDenied')
  const folder = state.folders[path] ?? newFolderState(path)
  const recents = { ...state.recents, folders: pushRecent(state.recents.folders, path) }
  return { state: withFolder({ ...state, folderPath: path, recents }, folder), result: folderInfoOf(folder) }
}

function requireReference(state: MockState) {
  if (!state.reference) throw ipcError('notReady', MESSAGES.noReference)
  return state.reference
}

/** Forgets analyses (the in-memory library goes with them); user decisions stay. */
function clearCache(folder: FolderState): FolderState {
  return { ...folder, cachedCount: 0, libraryCount: 0, scan: EMPTY_SCAN }
}

export const setupHandlers = {
  get_app_info: () => ({ result: APP_INFO }),

  reset_session: ({ state }) => {
    // Caches survive (analysis per folder, masters on disk); session data does not.
    const folders = Object.fromEntries(
      Object.entries(state.folders).map(([path, f]) => [
        path,
        { ...f, libraryCount: 0, scan: EMPTY_SCAN, decisions: EMPTY_DECISIONS },
      ]),
    )
    const next: MockState = {
      ...freshState(state.recents, state.frames),
      folders,
      outputs: state.outputs,
      discarded: state.discarded,
      exported: state.exported,
      clock: state.clock,
    }
    return { state: next, result: snapshotOf(next, null) }
  },

  pick_reference_photo: ({ state, options }) =>
    options.cancelDialogs ? { result: null } : setReference(state, CANNED_DIALOGS.referencePhoto),

  set_reference_photo: ({ state }, args) => setReference(state, absolutePath(args)),

  set_reference_rotation: ({ state }, args) => {
    const rotationDeg = num(args, 'rotationDeg')
    const ref = requireReference(state)
    if (Math.abs(rotationDeg) > MAX_ROTATION_DEG) throw invalid('Rotate by at most 45° either way.')
    const reference = rotateReference(ref, rotationDeg)
    return { state: { ...state, reference }, result: referenceStateOf(reference) }
  },

  set_reference_crop: ({ state }, args) => {
    const crop = rect(args, 'crop')
    const preset = aspect(args)
    const ref = requireReference(state)
    const error = cropError(ref, crop, preset)
    if (error) throw error
    const reference = cropReference(ref, crop, preset)
    return { state: { ...state, reference }, result: referenceStateOf(reference) }
  },

  pick_source_folder: ({ state, options }) =>
    options.cancelDialogs ? { result: null } : setFolder(state, CANNED_DIALOGS.sourceFolder),

  set_source_folder: ({ state }, args) => setFolder(state, absolutePath(args)),

  clear_scan_cache: ({ state }, args) => {
    const scope = cacheScope(args)
    const current = currentFolder(state)
    const targets = scope === 'all' ? Object.values(state.folders) : current ? [current] : []
    const removedEntries = targets.reduce((sum, f) => sum + f.cachedCount, 0)
    const next = targets.reduce((s, f) => withFolder(s, clearCache(f)), state)
    return { state: next, result: { removedEntries, freedBytes: removedEntries * CACHE_BYTES_PER_ENTRY } }
  },
} satisfies {
  [K in
    | 'get_app_info'
    | 'reset_session'
    | 'pick_reference_photo'
    | 'set_reference_photo'
    | 'set_reference_rotation'
    | 'set_reference_crop'
    | 'pick_source_folder'
    | 'set_source_folder'
    | 'clear_scan_cache']: Handler<K>
}
