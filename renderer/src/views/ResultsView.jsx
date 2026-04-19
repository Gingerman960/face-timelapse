import React, { useState, useEffect, useRef, createContext, useContext } from 'react'
import useAlignmentStore from '../store/alignmentStore'
import VideoExportModal from '../components/VideoExportModal'

// Thumbnail grid cells are ~160px CSS, 2x DPR ≈ 320 — 400px leaves headroom.
const GRID_THUMB_MAX_DIM = 400

// Cap on decoded thumbnails resident in renderer memory at once. Above
// this, the oldest still-onscreen-or-offscreen thumbnails get evicted
// back to placeholders. Prevents OOM on huge result sets (3k+ photos).
const GRID_THUMB_RESIDENT_CAP = 250

// Cap on concurrent getImageBase64 IPC calls fired from the grid.
// Without this, fast-scrolling past 3000+ thumbnails queues up thousands of
// parallel image decodes in the main process (each holding a full bitmap
// during canvas re-encode), which crashes the renderer as the in-flight
// base64 responses pile up.
const GRID_THUMB_LOAD_CONCURRENCY = 6

// Long-edge cap for the fullscreen viewer. The IMG is constrained to
// 90vw/90vh — even on a 4K retina display that's ≲ 2200 physical px.
// Loading the raw aligned PNG (commonly 3000×3000+) wastes ~10MB per
// data URL and ~36MB per decoded bitmap that Chromium retains in its
// image cache, accumulating across navigations until the renderer OOMs.
const VIEWER_MAX_DIM = 2400

// ────────────────────────────────────────────────────────────────────
// Shared IntersectionObserver — one instance for the whole grid instead
// of N-per-thumbnail. Each LazyThumbnail registers an element and a
// callback for load and for eviction; the observer dispatches when the
// element enters or leaves the viewport (+200px margin).
// ────────────────────────────────────────────────────────────────────
const ObserverContext = createContext(null)

function createSharedObserver() {
  const callbacks = new WeakMap()
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const handlers = callbacks.get(entry.target)
        if (!handlers) continue
        if (entry.isIntersecting) handlers.onEnter?.()
        else handlers.onLeave?.()
      }
    },
    { rootMargin: '200px' }
  )

  return {
    observe(el, onEnter, onLeave) {
      if (!el) return
      callbacks.set(el, { onEnter, onLeave })
      observer.observe(el)
    },
    unobserve(el) {
      if (!el) return
      callbacks.delete(el)
      observer.unobserve(el)
    },
    disconnect() {
      observer.disconnect()
    },
  }
}

// Global LRU of currently-resident thumbnails. Each entry is an evict
// callback that clears the thumbnail's React state and returns true on
// success, false if the thumbnail is still on-screen and should stay
// resident. Entries that refused to evict get moved to the MRU end so
// they remain tracked and don't silently fall out of the cap accounting.
function createThumbLRU(cap) {
  const order = new Map() // insertion order = LRU order
  return {
    add(key, evictFn) {
      if (order.has(key)) order.delete(key)
      order.set(key, evictFn)
      if (order.size <= cap) return
      // Snapshot keys so we can mutate `order` while iterating.
      const keys = Array.from(order.keys())
      const refused = []
      for (const k of keys) {
        if (order.size <= cap) break
        const fn = order.get(k)
        order.delete(k)
        const evicted = fn?.()
        if (evicted === false) refused.push([k, fn])
      }
      // Re-insert anything we couldn't evict at the MRU end, so it
      // stays in the LRU and gets re-considered on future adds.
      for (const [k, fn] of refused) order.set(k, fn)
    },
    remove(key) {
      order.delete(key)
    },
  }
}

const ThumbLRUContext = createContext(null)

// Shared FIFO queue that serialises grid thumbnail IPC calls. Each thumb
// calls `enqueue(shouldRun, work)` — the queue only executes `work()` when
// a worker slot opens AND `shouldRun()` still returns true (i.e., the
// thumb is still on-screen). This lets us drop requests for thumbs that
// scrolled past before they reached the front of the queue.
function createThumbLoadQueue(cap) {
  const pending = []
  let active = 0

  const pump = () => {
    while (active < cap && pending.length > 0) {
      const task = pending.shift()
      if (!task.shouldRun()) continue
      active++
      task
        .work()
        .catch(() => {})
        .finally(() => {
          active--
          pump()
        })
    }
  }

  return {
    enqueue(shouldRun, work) {
      pending.push({ shouldRun, work })
      pump()
    },
  }
}

const ThumbLoadQueueContext = createContext(null)

const LazyThumbnail = ({ outputPath, dateStr, index, onClick }) => {
  const [b64, setB64] = useState(null)
  const hostRef = useRef(null)
  const observerApi = useContext(ObserverContext)
  const lru = useContext(ThumbLRUContext)
  const queue = useContext(ThumbLoadQueueContext)
  const visibleRef = useRef(false)
  const loadedRef = useRef(false)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!outputPath || !hostRef.current || !observerApi) return
    const el = hostRef.current
    cancelledRef.current = false

    const load = () => {
      if (loadedRef.current || cancelledRef.current) return
      loadedRef.current = true
      const task = () =>
        window.electronAPI
          .getImageBase64(outputPath, { maxDim: GRID_THUMB_MAX_DIM })
          .then((data) => {
            if (cancelledRef.current || !visibleRef.current) return
            setB64(data)
            lru?.add(outputPath, () => {
              if (visibleRef.current) return false
              setB64(null)
              loadedRef.current = false
              return true
            })
          })
          .catch(() => { loadedRef.current = false })
      if (queue) {
        queue.enqueue(
          () => !cancelledRef.current && visibleRef.current,
          task,
        )
      } else {
        task()
      }
    }

    observerApi.observe(
      el,
      () => { visibleRef.current = true; load() },
      () => { visibleRef.current = false },
    )

    return () => {
      cancelledRef.current = true
      observerApi.unobserve(el)
      lru?.remove(outputPath)
    }
  }, [outputPath, observerApi, lru, queue])

  const handleKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick(index)
    }
  }

  return (
    <button
      type="button"
      className="results-card results-card-btn"
      ref={hostRef}
      onClick={() => onClick(index)}
      onKeyDown={handleKey}
      aria-label={dateStr ? `View photo from ${dateStr}` : `View photo ${index + 1}`}
    >
      {b64 ? (
        <img src={`data:image/jpeg;base64,${b64}`} className="results-img" alt="" />
      ) : (
        <div className="results-img placeholder">Loading</div>
      )}
      <div className="date-badge">{dateStr}</div>
    </button>
  )
}

const FullscreenViewer = ({ items, initialIndex, onClose }) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex)
  // imgUrl is a `blob:` URL so we can revokeObjectURL on unmount or
  // navigation. Using a base64 data URL would leave the decoded bitmap
  // pinned in Chromium's image cache (keyed by URL), which accumulates
  // over multiple opens/navigations until the renderer crashes.
  const [imgUrl, setImgUrl] = useState(null)
  const urlRef = useRef(null)
  const closeBtnRef = useRef(null)

  useEffect(() => {
    const item = items[currentIndex]
    if (!item || !item.outputPath) return
    let cancelled = false
    window.electronAPI
      .getImageBase64(item.outputPath, { maxDim: VIEWER_MAX_DIM })
      .then((data) => {
        if (cancelled) return
        // base64 → Uint8Array → Blob → blob URL.
        const binary = atob(data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const blob = new Blob([bytes], { type: 'image/jpeg' })
        const next = URL.createObjectURL(blob)
        // Revoke the previous URL only after the new one is ready, so the
        // IMG never points at a revoked blob mid-swap.
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        urlRef.current = next
        setImgUrl(next)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [currentIndex, items])

  // Final cleanup on unmount: revoke whatever URL is still resident.
  useEffect(() => () => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') setCurrentIndex((prev) => Math.min(items.length - 1, prev + 1))
      if (e.key === 'ArrowLeft') setCurrentIndex((prev) => Math.max(0, prev - 1))
    }
    window.addEventListener('keydown', handleKeyDown)
    // Move focus to the close button so screen readers and keyboard users
    // land inside the dialog. Previously focus stayed on the thumbnail
    // button behind the overlay.
    closeBtnRef.current?.focus()
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [items.length, onClose])

  const currentItem = items[currentIndex]
  const dateStr = currentItem?.creationDate ? new Date(currentItem.creationDate).toLocaleString() : ''

  return (
    <div
      className="fullscreen-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
    >
      <div className="fullscreen-content" onClick={(e) => e.stopPropagation()}>
        {imgUrl ? (
          <img src={imgUrl} className="fullscreen-img" alt="" />
        ) : (
          <div className="fullscreen-img placeholder text-muted">Loading high-res image…</div>
        )}

        <div className="fullscreen-topbar">
          <span>{currentIndex + 1} / {items.length}</span>
          <span>{dateStr}</span>
          <button
            ref={closeBtnRef}
            className="fullscreen-close"
            onClick={onClose}
            aria-label="Close viewer"
          >
            ×
          </button>
        </div>

        {currentIndex > 0 && (
          <button
            type="button"
            className="nav-zone nav-left"
            onClick={() => setCurrentIndex(currentIndex - 1)}
            aria-label="Previous photo"
          >
            <span className="nav-arrow" aria-hidden="true">‹</span>
          </button>
        )}
        {currentIndex < items.length - 1 && (
          <button
            type="button"
            className="nav-zone nav-right"
            onClick={() => setCurrentIndex(currentIndex + 1)}
            aria-label="Next photo"
          >
            <span className="nav-arrow" aria-hidden="true">›</span>
          </button>
        )}
      </div>
    </div>
  )
}

export default function ResultsView() {
  const {
    alignedResults, setStep, setError,
  } = useAlignmentStore()

  const [exportProgress, setExportProgressLocal] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [showVideoModal, setShowVideoModal] = useState(false)
  const [viewerIndex, setViewerIndex] = useState(null)

  // One shared observer per ResultsView mount — re-created only if the view
  // remounts. All LazyThumbnail children consume it via context.
  const observerRef = useRef(null)
  if (!observerRef.current) observerRef.current = createSharedObserver()
  const lruRef = useRef(null)
  if (!lruRef.current) lruRef.current = createThumbLRU(GRID_THUMB_RESIDENT_CAP)
  const queueRef = useRef(null)
  if (!queueRef.current) queueRef.current = createThumbLoadQueue(GRID_THUMB_LOAD_CONCURRENCY)
  useEffect(() => () => observerRef.current?.disconnect(), [])

  const handleExportFolder = async () => {
    const folder = await window.electronAPI.chooseFolder()
    if (!folder) return

    setExporting(true)
    const unsubscribe = window.electronAPI.onExportProgress((p) => {
      setExportProgressLocal(p)
    })

    try {
      await window.electronAPI.exportToFolder({ alignedResults, outputFolder: folder })
      setExportProgressLocal(null)
    } catch (err) {
      setError(err.message || 'Export failed')
    } finally {
      unsubscribe()
      setExporting(false)
    }
  }

  const handleCreateVideo = () => {
    setShowVideoModal(true)
  }

  const handleBack = () => {
    setStep('dailySelection')
  }

  const pct = exportProgress && exportProgress.total > 0
    ? Math.round(exportProgress.current / exportProgress.total * 100)
    : 0

  return (
    <ObserverContext.Provider value={observerRef.current}>
      <ThumbLRUContext.Provider value={lruRef.current}>
      <ThumbLoadQueueContext.Provider value={queueRef.current}>
      <div className="view-container flex-col p-0">
        <div className="results-gallery">
          <div className="title">{alignedResults.length} Aligned Photos</div>

          {exportProgress && (
            <div className="m-b-16">
              <div className="export-msg">Exporting… {exportProgress.filename}</div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          <div className="results-grid">
            {alignedResults.map((r, i) => {
              const dateStr = r.creationDate ? new Date(r.creationDate).toLocaleDateString() : ''
              return (
                <LazyThumbnail
                  key={r.outputPath || i}
                  outputPath={r.outputPath}
                  dateStr={dateStr}
                  index={i}
                  onClick={setViewerIndex}
                />
              )
            })}
          </div>
        </div>

        <div className="results-footer">
          <button className="btn btn-secondary" onClick={handleBack}>Back</button>
          <button
            className="btn btn-secondary"
            onClick={handleExportFolder}
            disabled={exporting || alignedResults.length === 0}
          >
            {exporting ? 'Exporting…' : 'Save to Folder'}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCreateVideo}
            disabled={alignedResults.length < 2}
          >
            Create Video
          </button>
          <div className="results-info">{alignedResults.length} photos</div>
        </div>

        {showVideoModal && <VideoExportModal onClose={() => setShowVideoModal(false)} />}

        {viewerIndex !== null && (
          <FullscreenViewer
            items={alignedResults}
            initialIndex={viewerIndex}
            onClose={() => setViewerIndex(null)}
          />
        )}
      </div>
      </ThumbLoadQueueContext.Provider>
      </ThumbLRUContext.Provider>
    </ObserverContext.Provider>
  )
}
