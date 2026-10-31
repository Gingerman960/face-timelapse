// A tiny pretend filesystem for path validation, plus the canned dialog paths.
//
// Known directories and images exist; HEIC/HEIF is always "unsupported";
// names containing "no_face" have no face; "broken" files fail to decode;
// the "Locked" folder denies access. Anything else under an absolute path is
// "not found".
import {
  DEMO_FOLDER,
  EXTRAS_DIR,
  EXTRA_NO_FACE_PATH,
  NO_FACE_REFERENCE_PATH,
  REFERENCE_DIR,
  REFERENCE_PATH,
  demoLibrary,
  extraPhotos,
} from './fixtures'

export const HOME = '/Users/demo'
export const PICTURES = `${HOME}/Pictures`
export const MOVIES = `${HOME}/Movies`
export const EMPTY_FOLDER = `${PICTURES}/Empty folder`
export const LOCKED_FOLDER = `${PICTURES}/Locked`
export const EXPORT_FOLDER = `${PICTURES}/Timelapse frames`
export const BROKEN_REFERENCE_PATH = `${REFERENCE_DIR}/IMG_20140816_broken.jpg`
export const HEIC_REFERENCE_PATH = `${REFERENCE_DIR}/IMG_20140817_101500.HEIC`

/** What each `pick_*` dialog returns unless dialogs are cancelled. */
export const CANNED_DIALOGS = {
  referencePhoto: REFERENCE_PATH,
  sourceFolder: DEMO_FOLDER,
  exportFolder: EXPORT_FOLDER,
  videoDir: MOVIES,
} as const

const DIRECTORIES: ReadonlySet<string> = new Set([
  '/',
  '/Users',
  HOME,
  PICTURES,
  MOVIES,
  `${HOME}/Desktop`,
  DEMO_FOLDER,
  `${DEMO_FOLDER}/2016`,
  REFERENCE_DIR,
  EXTRAS_DIR,
  EXPORT_FOLDER,
  EMPTY_FOLDER,
  LOCKED_FOLDER,
])

const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'webp']
const HEIC_EXTENSIONS = ['heic', 'heif']

export type PathKind =
  | { kind: 'relative' }
  | { kind: 'directory'; locked: boolean }
  | { kind: 'image'; noFace: boolean; broken: boolean }
  | { kind: 'heic' }
  | { kind: 'otherFile'; extension: string }
  | { kind: 'missing' }

/** Strips one trailing slash (not from "/"). */
export function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

export function baseName(path: string): string {
  const clean = normalizePath(path)
  return clean.slice(clean.lastIndexOf('/') + 1) || clean
}

export function parentDir(path: string): string {
  const clean = normalizePath(path)
  const i = clean.lastIndexOf('/')
  return i <= 0 ? '/' : clean.slice(0, i)
}

export function extensionOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

let knownImages: ReadonlySet<string> | null = null

function imageSet(): ReadonlySet<string> {
  knownImages ??= new Set([
    REFERENCE_PATH,
    NO_FACE_REFERENCE_PATH,
    BROKEN_REFERENCE_PATH,
    EXTRA_NO_FACE_PATH,
    ...extraPhotos().map((p) => p.path),
    ...demoLibrary().photos.map((p) => p.path),
  ])
  return knownImages
}

/** True for directories the mock filesystem knows. */
export function isDirectory(path: string): boolean {
  return DIRECTORIES.has(normalizePath(path))
}

export function classifyPath(path: string): PathKind {
  if (!path.startsWith('/')) return { kind: 'relative' }
  const clean = normalizePath(path)
  if (DIRECTORIES.has(clean)) return { kind: 'directory', locked: clean === LOCKED_FOLDER }
  const ext = extensionOf(clean)
  if (HEIC_EXTENSIONS.includes(ext)) return { kind: 'heic' }
  if (!imageSet().has(clean)) {
    return ext && !SUPPORTED_EXTENSIONS.includes(ext) && isDirectory(parentDir(clean))
      ? { kind: 'otherFile', extension: ext }
      : { kind: 'missing' }
  }
  const name = baseName(clean).toLowerCase()
  return { kind: 'image', noFace: name.includes('no_face'), broken: name.includes('broken') }
}

/** The `.mp4` path the save dialog would return for `suggestedName`. */
export function videoPathFor(suggestedName: string): string {
  const name = suggestedName.replaceAll('/', '-').trim() || 'FaceTimelapse.mp4'
  return `${MOVIES}/${name.toLowerCase().endsWith('.mp4') ? name : `${name}.mp4`}`
}
