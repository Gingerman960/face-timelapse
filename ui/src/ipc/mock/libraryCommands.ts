// Commands for photos, review decisions and days.
import type { DayGroup, DayKey, DaysPatch, PhotoDetail, PhotoId, Version } from '../contract'
import { MESSAGES, decodeFailed, invalid, ipcError, noFaceDetected, notFoundPath } from './errors'
import { daysOf, daysPatch, findDay } from './days'
import { type FixturePhoto, extraPhotos } from './fixtures'
import { adjustOf, fingerprintOf, frameVersionOf } from './frames'
import { libraryOf } from './library'
import { baseName, classifyPath, normalizePath } from './mockFs'
import { countsOf } from './session'
import type { Handler, Outcome } from './setupCommands'
import {
  type FolderDecisions,
  type FolderState,
  type MockState,
  currentFolder,
  omitKey,
  updateDecisions,
} from './state'
import { bool, dayKey, nullableStr, photoQuery, reviewDecision, str, stringList } from './validate'

function requireFolder(state: MockState): FolderState {
  const folder = currentFolder(state)
  if (!folder) throw ipcError('notReady', MESSAGES.noFolder)
  return folder
}

function requirePhoto(folder: FolderState | null, photoId: PhotoId): FixturePhoto {
  const photo = libraryOf(folder).fixtures.get(photoId)
  if (!photo) throw ipcError('notFound', MESSAGES.photoUnknown)
  return photo
}

function requireDay(folder: FolderState | null, key: DayKey): DayGroup {
  const day = findDay(folder, key)
  if (!day) throw ipcError('notFound', `There are no photos on ${key}.`)
  return day
}

const isManual = (d: FolderDecisions, id: PhotoId) => d.manualPhotos.some((m) => m.photoId === id)

/** Puts `photo` on `day`: manual photos move their entry; library photos get a day move (or lose it). */
function placeOnDay(d: FolderDecisions, photo: FixturePhoto, day: DayKey): FolderDecisions {
  if (isManual(d, photo.id) || photo.index < 0) {
    const others = d.manualPhotos.filter((m) => m.photoId !== photo.id)
    return { ...d, manualPhotos: [...others, { photoId: photo.id, dayKey: day }] }
  }
  const dayMoves = day === photo.dayKey ? omitKey(d.dayMoves, photo.id) : { ...d.dayMoves, [photo.id]: day }
  return { ...d, dayMoves }
}

function withPatch(state: MockState, next: MockState, keys: DayKey[]): Outcome<DaysPatch> {
  return { state: next, result: daysPatch(daysOf(currentFolder(state)), daysOf(currentFolder(next)), keys) }
}

function effectiveDay(folder: FolderState, photoId: PhotoId): DayKey | undefined {
  return libraryOf(folder).byId.get(photoId)?.dayKey
}

/** The photo `add_photo_to_day` should add for `path` (or throws the matching error). */
function photoForPath(folder: FolderState, path: string): FixturePhoto {
  const kind = classifyPath(path)
  const name = baseName(path)
  switch (kind.kind) {
    case 'relative':
      throw invalid('Use an absolute path.')
    case 'heic':
      throw ipcError('unsupportedFormat')
    case 'otherFile':
      throw ipcError('unsupportedFormat', `FaceTimelapse can't read .${kind.extension} files.`)
    case 'missing':
      throw notFoundPath(path)
    case 'directory':
      throw invalid("That's a folder. Choose a photo.")
    case 'image': {
      if (kind.broken) throw decodeFailed(name)
      if (kind.noFace) throw noFaceDetected(name)
      const photo =
        [...libraryOf(folder).fixtures.values()].find((p) => p.path === path) ??
        extraPhotos().find((p) => p.path === path)
      if (!photo) throw invalid('Choose a photo from the library folder or from Extras.')
      if (photo.matchedFace === null) throw noFaceDetected(name)
      return photo
    }
  }
}

/** Next photo the "Add a photo…" dialog offers: the first extra not added yet. */
function dialogPhoto(folder: FolderState): FixturePhoto | undefined {
  const extras = extraPhotos()
  return extras.find((p) => !isManual(folder.decisions, p.id)) ?? extras[0]
}

/**
 * v1.7 `PhotoDetail.previewVersion`: the aligned frame this photo would get now
 * (look off), null without a matched face or a reference face. The token packs
 * the render state, so the mock image server draws `preview/{id}` like `aligned/{id}`.
 */
function previewVersionOf(state: MockState, photo: FixturePhoto, photoVersion: Version): Version | null {
  const fingerprint = fingerprintOf(state)
  if (fingerprint === null || photo.matchedFace === null) return null
  const plain: MockState = { ...state, look: { ...state.look, normalize: 'off' } }
  return frameVersionOf(plain, fingerprint, photoVersion, adjustOf(state, photo.id))
}

export const libraryHandlers = {
  get_photos: ({ state }, args) => {
    const query = photoQuery(args)
    const { photos } = libraryOf(requireFolder(state))
    const statuses = query.statuses
    return { result: statuses === null ? [...photos] : photos.filter((p) => statuses.includes(p.status)) }
  },

  get_photo: ({ state }, args) => {
    const photoId = str(args, 'photoId')
    const folder = currentFolder(state)
    const photo = requirePhoto(folder, photoId)
    const summary = libraryOf(folder).byId.get(photoId)
    if (!summary) throw ipcError('notFound', MESSAGES.photoUnknown)
    const detail: PhotoDetail = {
      summary,
      path: photo.path,
      faces: photo.faces,
      matchedFace: photo.matchedFace,
      rawSimilarity: photo.rawSimilarity,
      previewVersion: previewVersionOf(state, photo, summary.version),
    }
    return { result: detail }
  },

  set_review_decision: ({ state }, args) => {
    const photoIds = stringList(args, 'photoIds')
    const decision = reviewDecision(args)
    const folder = currentFolder(state)
    const photos = photoIds.map((id) => requirePhoto(folder, id))
    if (decision === 'confirmed' && photos.some((p) => p.status === 'noFace' || p.status === 'failed')) {
      throw invalid("A photo without a face can't be kept.")
    }
    const next = updateDecisions(state, (d) => {
      const manualRejected = new Set(photos.filter((p) => decision === 'rejected' && isManual(d, p.id)).map((p) => p.id))
      const reviews = photos
        .filter((p) => !isManual(d, p.id))
        .reduce<FolderDecisions['reviews']>(
          (acc, p) => (decision === 'pending' ? omitKey(acc, p.id) : { ...acc, [p.id]: decision }),
          d.reviews,
        )
      return { ...d, reviews, manualPhotos: d.manualPhotos.filter((m) => !manualRejected.has(m.photoId)) }
    })
    return { state: next, result: countsOf(currentFolder(next)) }
  },

  get_days: ({ state }) => ({ result: [...daysOf(requireFolder(state))] }),

  select_day_photo: ({ state }, args) => {
    const key = dayKey(args)
    const photoId = str(args, 'photoId')
    const folder = currentFolder(state)
    const day = requireDay(folder, key)
    requirePhoto(folder, photoId)
    if (!day.photoIds.includes(photoId)) throw invalid("That photo isn't on this day.")
    const next = updateDecisions(state, (d) => ({ ...d, daySelections: { ...d.daySelections, [key]: photoId } }))
    return { state: next, result: requireDay(currentFolder(next), key) }
  },

  move_photo_to_day: ({ state }, args) => {
    const photoId = str(args, 'photoId')
    const key = dayKey(args)
    const folder = requireFolder(state)
    const photo = requirePhoto(folder, photoId)
    const from = effectiveDay(folder, photoId) ?? photo.dayKey
    const next = updateDecisions(state, (d) => placeOnDay(d, photo, key))
    return withPatch(state, next, [from, key])
  },

  add_photo_to_day: ({ state, options }, args) => {
    const key = dayKey(args)
    const rawPath = nullableStr(args, 'path')
    const folder = requireFolder(state)
    if (rawPath === null && options.cancelDialogs) return { result: null }
    const photo = rawPath === null ? dialogPhoto(folder) : photoForPath(folder, normalizePath(rawPath))
    if (!photo) return { result: null }
    const from = effectiveDay(folder, photo.id)
    const next = updateDecisions(state, (d) => {
      const placed = placeOnDay(d, photo, key)
      return photo.index < 0 ? placed : { ...placed, reviews: { ...placed.reviews, [photo.id]: 'confirmed' } }
    })
    return withPatch(state, next, from ? [from, key] : [key])
  },

  set_day_excluded: ({ state }, args) => {
    const key = dayKey(args)
    const excluded = bool(args, 'excluded')
    requireDay(currentFolder(state), key)
    const next = updateDecisions(state, (d) => ({
      ...d,
      excludedDays: excluded ? [...new Set([...d.excludedDays, key])] : d.excludedDays.filter((k) => k !== key),
    }))
    return { state: next, result: requireDay(currentFolder(next), key) }
  },
} satisfies {
  [K in
    | 'get_photos'
    | 'get_photo'
    | 'set_review_decision'
    | 'get_days'
    | 'select_day_photo'
    | 'move_photo_to_day'
    | 'add_photo_to_day'
    | 'set_day_excluded']: Handler<K>
}
