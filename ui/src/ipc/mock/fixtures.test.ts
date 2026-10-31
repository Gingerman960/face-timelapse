import { describe, expect, it } from 'vitest'
import { allDayKeys, decadeFraction, planLibrary } from './calendar'
import {
  DEMO_FOLDER,
  EXTRAS_DIR,
  LIBRARY_SIZE,
  REFERENCE_AUTO_ROTATION_DEG,
  REFERENCE_FACE,
  RESTORED_CROP,
  STATUS_TOTALS,
  demoLibrary,
  detectionFor,
  extraPhotos,
  fixturePhoto,
  fixturePhotoByPath,
  isValidDayKey,
  naturalCompare,
  photoGeometry,
  photoIdFor,
  photoVersionFor,
  portraitParams,
  rawSimilarityFor,
  referenceGeometry,
  referencePortraitParams,
  referenceTwin,
} from './fixtures'

const lib = demoLibrary()
const byDay = (day: string) => lib.photos.filter((p) => p.dayKey === day)

describe('fixtures: library narrative', () => {
  it('has 3,593 photos with the fixed status totals', () => {
    expect(lib.photos).toHaveLength(LIBRARY_SIZE)
    const counts = { confirmed: 0, uncertain: 0, rejected: 0, noFace: 0, failed: 0 }
    for (const p of lib.photos) counts[p.status] += 1
    expect(counts).toEqual(STATUS_TOTALS)
  })

  it('spans 2012-09-01 to 2022-08-31 with ~100 empty days and 40 multi-photo days', () => {
    expect(allDayKeys()).toHaveLength(3652)
    const days = new Map<string, number>()
    for (const p of lib.photos) days.set(p.dayKey, (days.get(p.dayKey) ?? 0) + 1)
    expect(days.size).toBe(3551)
    expect(lib.photos[0]?.dayKey).toBe('2012-09-01')
    expect(lib.photos.at(-1)?.dayKey).toBe('2022-08-31')
    const multi = [...days.values()].filter((n) => n > 1)
    expect(multi).toHaveLength(40)
    expect(multi.filter((n) => n === 3).length).toBeGreaterThanOrEqual(1)
    expect(days.has('2014-04-29')).toBe(false)
  })

  it('keeps the narrative days exact', () => {
    expect(byDay('2014-05-02').map((p) => p.takenAt.slice(11, 16))).toEqual(['00:41', '08:41', '12:23'])
    expect(byDay('2014-05-03')).toHaveLength(1)
    const spotlight = lib.photos.find((p) => p.takenAt === '2017-03-03T21:07:14')
    expect(spotlight).toMatchObject({ status: 'uncertain', score: 0.47 })
    expect(spotlight?.faces).toHaveLength(2)
    const uncertain = lib.byRelPath.filter((p) => p.status === 'uncertain')
    expect(uncertain[11]?.takenAt).toBe('2017-03-03T21:07:14')
    expect(uncertain.filter((p) => p.reviewOutcome === 'confirmed')).toHaveLength(29)
    expect(uncertain.filter((p) => p.reviewOutcome === 'rejected')).toHaveLength(12)
  })

  // Contract v1.4: EXIF photos and timed file names carry a time; date-only
  // names (dated 00:00) and file times don't. The last day, where Days lands, is date-only.
  it('mixes photos with a time of day and date-only file names', () => {
    expect(byDay('2022-08-31')).toEqual([
      expect.objectContaining({ fileName: 'IMG_20220831.jpg', dateSource: 'filename', takenAt: '2022-08-31T00:00:00', timeKnown: false }),
    ])
    const named = lib.photos.filter((p) => p.dateSource === 'filename')
    const dateOnly = named.filter((p) => !p.timeKnown)
    expect(dateOnly.length).toBeGreaterThan(10)
    expect(named.length - dateOnly.length).toBeGreaterThan(10)
    for (const p of dateOnly) {
      expect(p.takenAt.endsWith('T00:00:00')).toBe(true)
      expect(p.fileName).toMatch(/^(IMG_)?\d{8}\.jpg$/)
    }
    expect(lib.photos.filter((p) => p.dateSource === 'exif').every((p) => p.timeKnown)).toBe(true)
    expect(lib.photos.filter((p) => p.dateSource === 'fileTime').some((p) => p.timeKnown)).toBe(false)
    expect(extraPhotos().every((p) => p.timeKnown)).toBe(true)
  })

  it('scores match their status bands', () => {
    for (const p of lib.photos) {
      if (p.status === 'confirmed') expect(p.score).toBeGreaterThanOrEqual(0.6)
      if (p.status === 'uncertain') expect(p.score >= 0.4 && p.score < 0.6).toBe(true)
      if (p.status === 'rejected') expect(p.score).toBeLessThan(0.4)
      if (p.status === 'noFace') expect(p.score).toBe(0)
    }
  })

  it('dates mostly come from EXIF, ~3 % from file names, a few from file times', () => {
    const sources = { exif: 0, filename: 0, fileTime: 0 }
    for (const p of lib.photos) sources[p.dateSource] += 1
    expect(sources.fileTime).toBe(6)
    expect(sources.filename / LIBRARY_SIZE).toBeGreaterThan(0.025)
    expect(sources.filename / LIBRARY_SIZE).toBeLessThan(0.04)
  })

  it('uses camera-style names, a 2016/ subfolder and absolute paths in the demo folder', () => {
    for (const p of lib.photos) {
      expect(p.path).toBe(`${DEMO_FOLDER}/${p.relPath}`)
      expect(p.relPath.endsWith(p.fileName)).toBe(true)
      if (p.dateSource === 'fileTime') expect(p.fileName).toMatch(/^FB_IMG_\d{13}\.jpg$/)
      else if (p.timeKnown) expect(p.fileName).toMatch(/^(IMG_)?\d{8}_\d{6}\.jpg$/)
      else expect(p.fileName).toMatch(/^(IMG_)?\d{8}\.jpg$/)
      expect(p.relPath.startsWith('2016/')).toBe(p.takenAt.startsWith('2016-'))
    }
    expect(lib.photos.some((p) => p.fileName === 'IMG_20140815_142326.jpg')).toBe(true)
    expect(lib.photos.some((p) => p.fileName === '20120901_' + p.takenAt.slice(11).replaceAll(':', '') + '.jpg')).toBe(
      true,
    )
  })

  it('has unique 16-hex ids and 8-hex versions', () => {
    expect(new Set(lib.photos.map((p) => p.id)).size).toBe(LIBRARY_SIZE)
    for (const p of lib.photos.slice(0, 200)) {
      expect(p.id).toMatch(/^[0-9a-f]{16}$/)
      expect(p.version).toMatch(/^[0-9a-f]{8}$/)
      expect(p.id).toBe(photoIdFor(p.path))
      expect(p.version).toBe(photoVersionFor(p.path))
    }
  })

  it('places 1–3 faces with five ordered anchors, 18–30 % wide, matched face = faceBox source', () => {
    for (const p of lib.photos) {
      if (p.status === 'noFace') {
        expect(p.faces).toEqual([])
        expect(p.matchedFace).toBeNull()
        expect(p.rawSimilarity).toBeNull()
        continue
      }
      expect(p.faces.length).toBeGreaterThanOrEqual(1)
      expect(p.faces.length).toBeLessThanOrEqual(3)
      const matched = p.faces[p.matchedFace ?? -1]
      expect(matched).toBeDefined()
      expect(matched?.bounds.width).toBeGreaterThanOrEqual(0.179)
      expect(matched?.bounds.width).toBeLessThanOrEqual(0.301)
      for (const face of p.faces) {
        const [le, re, nose, ml, mr] = face.anchors
        expect(face.anchors).toHaveLength(5)
        expect(le!.x).toBeLessThan(re!.x)
        expect(ml!.x).toBeLessThan(mr!.x)
        expect(nose!.y).toBeGreaterThan(Math.min(le!.y, re!.y))
        expect(ml!.y).toBeGreaterThan(nose!.y)
      }
      const areas = p.faces.map((f) => f.bounds.width * f.bounds.height * p.size.width * p.size.height)
      expect(areas).toEqual([...areas].sort((a, b) => b - a))
    }
  })

  it('uses phone sizes, some portrait', () => {
    const sizes = new Set(lib.photos.map((p) => `${p.size.width}x${p.size.height}`))
    expect(sizes).toEqual(new Set(['3264x2448', '2448x3264', '4032x3024', '3024x4032']))
  })

  it('is deterministic', () => {
    expect(planLibrary()).toEqual(planLibrary())
    expect(portraitParams('abc', '2015-01-01T10:00:00')).toEqual(portraitParams('abc', '2015-01-01T10:00:00'))
  })
})

describe('fixtures: lookups and helpers', () => {
  it('finds photos by id and path, including extras', () => {
    const photo = lib.photos[42]!
    expect(fixturePhoto(photo.id)).toBe(photo)
    expect(fixturePhotoByPath(photo.path)).toBe(photo)
    const extra = extraPhotos()[0]!
    expect(extra.path.startsWith(EXTRAS_DIR)).toBe(true)
    expect(extra.relPath).toBe(extra.path)
    expect(fixturePhoto(extra.id)).toBe(extra)
    expect(fixturePhoto('0000000000000000')).toBeUndefined()
    expect(photoGeometry(photo.id)).toEqual({ size: photo.size, faces: photo.faces, matchedFace: photo.matchedFace })
    expect(photoGeometry('nope')).toBeNull()
  })

  it('sorts names naturally', () => {
    const names = ['IMG_10.jpg', 'IMG_9.jpg', '2016/IMG_1.jpg', '20120901_1.jpg', 'FB_IMG_1.jpg', 'img_9.jpg']
    expect(names.slice().sort(naturalCompare)).toEqual([
      '2016/IMG_1.jpg',
      '20120901_1.jpg',
      'FB_IMG_1.jpg',
      'IMG_9.jpg',
      'img_9.jpg',
      'IMG_10.jpg',
    ])
    expect(naturalCompare('a01', 'a1')).not.toBe(0)
    expect(naturalCompare('a', 'a')).toBe(0)
    expect(naturalCompare('a', 'a.b')).toBeLessThan(0)
  })

  it('inverts the score calibration', () => {
    expect(rawSimilarityFor(0.6)).toBeCloseTo(0.363, 4)
    expect(rawSimilarityFor(1)).toBeCloseTo(1, 4)
    expect(rawSimilarityFor(0.4)).toBeCloseTo(0.2, 4)
    expect(rawSimilarityFor(0)).toBeCloseTo(0.037, 4)
  })

  it('validates day keys and maps the decade', () => {
    expect(isValidDayKey('2014-05-02')).toBe(true)
    expect(isValidDayKey('2014-02-30')).toBe(false)
    expect(isValidDayKey('20140502')).toBe(false)
    expect(decadeFraction('2012-09-01')).toBe(0)
    expect(decadeFraction('2030-01-01')).toBe(1)
  })

  it('grows a beard in the last third of the decade', () => {
    const early = portraitParams('x', '2013-03-01T10:00:00')
    const late = portraitParams('x', '2022-08-01T10:00:00')
    expect(late.beard).toBe(1)
    expect(early.beard).toBeLessThan(0.3)
    expect(Math.abs(late.exposureEv)).toBeLessThanOrEqual(1.2)
    expect(portraitParams('x', '2013-03-01T10:00:00', 'other').skin).not.toBe(early.skin)
  })
})

describe('fixtures: reference geometry', () => {
  it('matches the reference photo at rotation 0', () => {
    const g = referenceGeometry(0, true)
    expect(g.size).toEqual({ width: 3200, height: 2368 })
    expect(g.face).toEqual(REFERENCE_FACE)
    expect(g.autoRotationDeg).toBe(REFERENCE_AUTO_ROTATION_DEG)
    expect(referenceGeometry(0, false)).toEqual({ size: g.size, face: null, autoRotationDeg: null })
  })

  it('expands the canvas and moves the face with rotation', () => {
    const g = referenceGeometry(10, true)
    expect(g.size.width).toBeGreaterThan(3200)
    expect(g.size.height).toBeGreaterThan(2368)
    // Absolute (EXIF-oriented photo), as the engine reports it: rotation doesn't change it.
    expect(g.autoRotationDeg).toBeCloseTo(-0.2, 5)
    const [le, re] = g.face!.anchors
    expect(re!.y).toBeGreaterThan(le!.y)
  })

  it('detects the face in the restored crop and not in a crop that excludes it', () => {
    const g = referenceGeometry(0, true)
    const d = detectionFor(g, RESTORED_CROP)
    expect(d?.anchors[0]).toEqual({ x: 0.3834, y: 0.4286 })
    expect(d?.faceBox.width).toBeCloseTo(0.4423, 4)
    expect(detectionFor(g, { x: 0, y: 0, width: 600, height: 600 })).toBeNull()
    expect(detectionFor(g, { x: 0, y: 0, width: 0, height: 10 })).toBeNull()
    expect(detectionFor(referenceGeometry(0, false), RESTORED_CROP)).toBeNull()
  })

  it('renders the reference as its library twin with neutral exposure', () => {
    expect(referenceTwin()?.fileName).toBe('IMG_20140815_142326.jpg')
    expect(referencePortraitParams()).toMatchObject({ exposureEv: 0, warmth: 0, beard: 0 })
  })
})
