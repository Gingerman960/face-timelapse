import type { FrameSummary, LibraryCounts, ReferenceState, SessionSnapshot } from '../ipc/contract'

/** A reference with a detected face and a 3:4 crop (the restored-session shape). */
export function makeReference(overrides: Partial<ReferenceState> = {}): ReferenceState {
  return {
    image: {
      path: '/Users/demo/Pictures/Reference/IMG_20140815_142326.jpg',
      fileName: 'IMG_20140815_142326.jpg',
      rotationDeg: 0,
      autoRotationDeg: -0.2,
      size: { width: 3200, height: 2368 },
      face: { bounds: { x: 0.385, y: 0.25, width: 0.23, height: 0.48 }, anchors: [], confidence: 0.98 },
      version: 'aa11bb22',
    },
    crop: { x: 746, y: 0, width: 1664, height: 2219 },
    aspect: '3:4',
    detection: {
      anchors: [
        { x: 0.384, y: 0.429 },
        { x: 0.652, y: 0.429 },
        { x: 0.507, y: 0.557 },
        { x: 0.404, y: 0.667 },
        { x: 0.635, y: 0.667 },
      ],
      faceBox: { x: 0.27, y: 0.26, width: 0.5, height: 0.56 },
      confidence: 0.97,
    },
    version: 'cc33dd44',
    ...overrides,
  }
}

const COUNTS: LibraryCounts = {
  total: 3593,
  confirmed: 3529,
  uncertain: 41,
  rejected: 6,
  noFace: 17,
  failed: 0,
  reviewPending: 0,
  included: 3558,
  days: 3547,
  activeDays: 3547,
}

/** A session snapshot; `stage` picks a point in the workflow. */
export function makeSession(stage: 'fresh' | 'ready' | 'scanned' | 'reviewed' | 'aligned' = 'aligned', overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const base: SessionSnapshot = {
    reference: null,
    folder: null,
    scan: { status: 'none', lastSummary: null, scannedAt: null },
    counts: { ...COUNTS, total: 0, confirmed: 0, uncertain: 0, rejected: 0, noFace: 0, included: 0, days: 0, activeDays: 0 },
    render: { resolution: '1080p', backdrop: 'extended', refineLandmarks: true },
    look: { normalize: 'off', strength: 0.7 },
    frames: { status: 'none', count: 0, expected: 0, outputSize: null },
    imageExport: { format: 'png', jpegQuality: 95, overwrite: false },
    video: {
      pace: { mode: 'fps', fps: 30 },
      resolution: 'source',
      quality: 'high',
      crossfade: { frames: 0, easing: 'easeInOut' },
      caption: null,
      holdFirstSecs: 0,
      holdLastSecs: 1,
    },
    activeJob: null,
    recents: { references: [], folders: [] },
  }
  if (stage === 'fresh') return { ...base, ...overrides }
  const ready: SessionSnapshot = {
    ...base,
    reference: makeReference(),
    folder: { path: '/Users/demo/Pictures/Daily selfies', name: 'Daily selfies', imageCount: 3593, analyzedCount: 412, unsupportedCount: 2 },
  }
  if (stage === 'ready') return { ...ready, ...overrides }
  const scanned: SessionSnapshot = {
    ...ready,
    scan: { status: 'complete', lastSummary: null, scannedAt: '2026-10-24T10:00:00' },
    counts: { ...COUNTS, reviewPending: 41, included: 3529, days: 3520, activeDays: 3520 },
  }
  if (stage === 'scanned') return { ...scanned, ...overrides }
  const reviewed: SessionSnapshot = { ...scanned, counts: COUNTS }
  if (stage === 'reviewed') return { ...reviewed, ...overrides }
  return {
    ...reviewed,
    frames: { status: 'complete', count: 3547, expected: 3547, outputSize: { width: 1080, height: 1440 } },
    ...overrides,
  }
}

/** `n` chronological frames starting at `start`. */
export function makeFrames(n: number, start = '2014-01-01'): FrameSummary[] {
  const t0 = Date.parse(`${start}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(t0 + i * 86_400_000).toISOString().slice(0, 10)
    return {
      photoId: i.toString(16).padStart(16, '0'),
      dayKey: day,
      takenAt: `${day}T12:00:00`,
      timeKnown: true,
      version: 'v' + String(i),
      residualPx: i === 3 ? 9 : 1.2,
      adjust: { dx: 0, dy: 0, scale: 1, rotationDeg: 0 },
      lookDelta: null,
    }
  })
}
