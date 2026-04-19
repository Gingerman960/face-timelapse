import { create } from 'zustand'

/**
 * Zustand store — mirrors AlignmentViewModel.swift state shape.
 *
 * Workflow steps:
 *   setup → scanning → confirm → dailySelection → aligning → results → videoExport
 */
const useAlignmentStore = create((set, get) => ({
  // --- Workflow step ---
  step: 'setup',
  setStep: (step) => set({ step }),

  // --- Reference photo ---
  referenceImagePath: null,
  referencePreviewBase64: null,
  referenceLandmarks68: null,
  referenceAlignmentPoints: null,
  referenceImageSize: null,
  referenceEmbedding: null,
  referenceOutputSize: null,  // {w, h} matching selected aspect ratio
  cropParams: null,           // {x, y, width, height} in original pixel coords
  aspectRatio: 'original',

  setAspectRatio: (aspectRatio) => set({ aspectRatio }),
  setCropParams: (cropParams) => set({ cropParams }),

  setReferenceResult: (result) => set({
    referencePreviewBase64: result.previewBase64,
    referenceLandmarks68: result.landmarks68,
    referenceAlignmentPoints: result.alignmentPoints,
    referenceImageSize: result.imageSize,
    referenceEmbedding: result.embedding,
    referenceOutputSize: result.outputSize,
  }),

  setReferenceImagePath: (p) => set({ referenceImagePath: p }),

  // --- Source folder ---
  sourceFolderPath: null,
  setSourceFolderPath: (p) => set({ sourceFolderPath: p }),

  // --- Scan ---
  scanProgress: null,          // { index, total, filename, thumbnailBase64, status }
  candidates: [],              // PhotoCandidate[]
  setScanProgress: (p) => set({ scanProgress: p }),
  setCandidates: (c) => set({ candidates: c }),

  // Update individual candidate status
  setCandidateStatus: (index, status) => set((state) => {
    const updated = [...state.candidates]
    updated[index] = { ...updated[index], status }
    return { candidates: updated }
  }),

  // --- Daily groups (computed client-side from confirmed candidates) ---
  dailyGroups: [],
  setDailyGroups: (groups) => set({ dailyGroups: groups }),
  setDailyGroupSelection: (groupIndex, photoIndex) => set((state) => {
    const updated = [...state.dailyGroups]
    updated[groupIndex] = { ...updated[groupIndex], selectedIndex: photoIndex }
    return { dailyGroups: updated }
  }),
  movePhotoToDate: (fromGroupIdx, photoIdx, toDateKey) => set((state) => {
    const srcGroup = state.dailyGroups[fromGroupIdx]
    if (!srcGroup || !srcGroup.photos[photoIdx]) return {}
    if (srcGroup.date === toDateKey) return {}

    // Stamp the photo with a new creationDate pinned to local noon of the
    // target day. `new Date('YYYY-MM-DDT12:00:00')` without a TZ suffix is
    // parsed as local time per ISO 8601; `groupByDay` re-buckets by the
    // local-date portion of creationDate, so the photo lands in the target
    // day regardless of the user's timezone.
    const movedPhoto = {
      ...srcGroup.photos[photoIdx],
      creationDate: new Date(toDateKey + 'T12:00:00').toISOString(),
    }

    const rebuilt = state.dailyGroups.map((g, i) => {
      if (i !== fromGroupIdx) return { ...g, photos: [...g.photos] }
      const remaining = g.photos.filter((_, pi) => pi !== photoIdx)
      // Keep the user's selection pointed at the same photo. If we removed
      // a photo before the selection, shift left by one; if we removed the
      // selected photo itself, fall back to the photo now occupying its slot
      // (clamped to the new end).
      let selectedIndex
      if (photoIdx < g.selectedIndex) selectedIndex = g.selectedIndex - 1
      else if (photoIdx === g.selectedIndex) selectedIndex = Math.min(g.selectedIndex, Math.max(0, remaining.length - 1))
      else selectedIndex = g.selectedIndex
      return { ...g, photos: remaining, selectedIndex }
    })

    const tgtIdx = rebuilt.findIndex((g) => g.date === toDateKey)
    if (tgtIdx === -1) {
      rebuilt.push({ date: toDateKey, photos: [movedPhoto], selectedIndex: 0 })
    } else {
      const tgt = rebuilt[tgtIdx]
      const merged = [...tgt.photos, movedPhoto].sort((a, b) => b.similarityScore - a.similarityScore)
      rebuilt[tgtIdx] = { ...tgt, photos: merged }
    }

    const nonEmpty = rebuilt
      .filter((g) => g.photos.length > 0)
      .sort((a, b) => a.date.localeCompare(b.date))
    return { dailyGroups: nonEmpty }
  }),

  // --- Alignment ---
  alignProgress: null,         // { current, total }
  alignedResults: [],          // { filePath, outputPath, creationDate, similarityScore, ... }
  setAlignProgress: (p) => set({ alignProgress: p }),
  setAlignedResults: (r) => set({ alignedResults: r }),

  // --- Video export ---
  videoProgress: null,         // { percent, timemark }
  setVideoProgress: (p) => set({ videoProgress: p }),

  // --- Errors ---
  error: null,
  setError: (msg) => set({ error: msg }),
  clearError: () => set({ error: null }),

  // --- Reset ---
  reset: () => set({
    step: 'setup',
    referenceImagePath: null,
    referencePreviewBase64: null,
    referenceLandmarks68: null,
    referenceAlignmentPoints: null,
    referenceImageSize: null,
    referenceEmbedding: null,
    referenceOutputSize: null,
    cropParams: null,
    aspectRatio: 'original',
    sourceFolderPath: null,
    scanProgress: null,
    candidates: [],
    dailyGroups: [],
    alignProgress: null,
    alignedResults: [],
    videoProgress: null,
    error: null,
  }),
}))

export default useAlignmentStore

// --- photoFilter helpers (pure JS, runs in renderer) ---

export function groupByDay(candidates) {
  const confirmed = candidates.filter((c) => c.status === 'confirmed')

  const byDay = {}
  for (const c of confirmed) {
    const d = new Date(c.creationDate)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (!byDay[key]) byDay[key] = { date: key, photos: [] }
    byDay[key].photos.push(c)
  }

  return Object.values(byDay)
    .map((g) => ({
      ...g,
      photos: [...g.photos].sort((a, b) => b.similarityScore - a.similarityScore),
      selectedIndex: 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

export function getSelectedPhotos(dailyGroups) {
  return dailyGroups
    .map((g) => g.photos[g.selectedIndex])
    .filter(Boolean)
    .sort((a, b) => new Date(a.creationDate) - new Date(b.creationDate))
}
