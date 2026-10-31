// IpcError factory with the friendly messages of ARCHITECTURE §7.2.
// Every rejection of the fake backend is a plain `{ kind, message }` object.
import type { ErrorKind, IpcError } from '../contract'

export const ERROR_KINDS: readonly ErrorKind[] = [
  'noFaceInReference',
  'noFaceDetected',
  'notFound',
  'invalidArgument',
  'unsupportedFormat',
  'decodeFailed',
  'permissionDenied',
  'diskFull',
  'io',
  'busy',
  'cancelled',
  'notReady',
  'modelUnavailable',
  'encodeFailed',
  'internal',
]

/** Default user-facing message per kind (used for injected failures and generic cases). */
export const DEFAULT_MESSAGES: Readonly<Record<ErrorKind, string>> = {
  noFaceInReference: 'No face found inside the crop. Widen the crop or pick another reference photo.',
  noFaceDetected: "No face found in that photo, so it can't be added to this day.",
  notFound: 'This file is no longer there.',
  invalidArgument: "That request wasn't valid.",
  unsupportedFormat: "HEIC photos aren't supported yet. Export them as JPEG first.",
  decodeFailed: "That photo couldn't be read. The file may be damaged.",
  permissionDenied:
    "FaceTimelapse isn't allowed to read that folder. Grant access in System Settings › Privacy & Security.",
  diskFull: 'The disk is full. Free some space and try again.',
  io: "Something went wrong reading or writing a file. Try again.",
  busy: 'Another task is running. Wait for it to finish or cancel it.',
  cancelled: 'The task was cancelled.',
  notReady: 'Choose a source folder first.',
  modelUnavailable: "The face models couldn't be loaded. Reinstall FaceTimelapse.",
  encodeFailed: "The video couldn't be encoded. Try another size or quality.",
  internal: "Something unexpected went wrong. Try again, and restart FaceTimelapse if it keeps happening.",
}

/** Context-specific messages used by more than one command. */
export const MESSAGES = {
  noFolder: 'Choose a source folder first.',
  noReference: 'Choose a reference photo first.',
  noScan: 'Scan the library first.',
  noActiveDays: 'Keep at least one day before aligning.',
  noFrames: 'Align at least one day first.',
  tooFewFrames: 'Align at least two days first.',
  photoUnknown: "That photo isn't in this library.",
  notWritable:
    "FaceTimelapse isn't allowed to write to that folder. Grant access in System Settings › Privacy & Security.",
  notGranted: 'FaceTimelapse can only use files and folders you choose or drop onto its window.',
  /** v1.7 `open_path`: every refusal (not an exported video, or gone). */
  notOpenable:
    "That video can't be opened. FaceTimelapse opens only videos it exported that are still where it saved them.",
} as const

export function ipcError(kind: ErrorKind, message: string = DEFAULT_MESSAGES[kind]): IpcError {
  return { kind, message }
}

export const notFoundPath = (path: string): IpcError => ipcError('notFound', `This file is no longer there: ${path}`)

export const decodeFailed = (fileName: string): IpcError =>
  ipcError('decodeFailed', `${fileName} couldn't be read. The file may be damaged.`)

export const noFaceDetected = (fileName: string): IpcError =>
  ipcError('noFaceDetected', `No face found in ${fileName}, so it can't be added to this day.`)

export const invalid = (message: string): IpcError => ipcError('invalidArgument', message)

export function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === 'string' && (ERROR_KINDS as readonly string[]).includes(value)
}

/** True for a plain `{ kind, message }` object with a known kind. */
export function isIpcError(value: unknown): value is IpcError {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return isErrorKind(v.kind) && typeof v.message === 'string'
}
