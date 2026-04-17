import React, { useState, useEffect, useRef, createContext, useContext } from 'react'
import useAlignmentStore from '../store/alignmentStore'
import VideoExportModal from '../components/VideoExportModal'

// ────────────────────────────────────────────────────────────────────
// Shared IntersectionObserver — one instance for the whole grid instead
// of N-per-thumbnail. Each LazyThumbnail registers an element and a
// callback; the observer dispatches to callbacks only when the element
// intersects the viewport (+200px margin).
// ────────────────────────────────────────────────────────────────────
const ObserverContext = createContext(null)

function createSharedObserver() {
  const callbacks = new WeakMap()
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const cb = callbacks.get(entry.target)
        if (cb) {
          cb()
          // One-shot: once visible, stop watching this element.
          observer.unobserve(entry.target)
          callbacks.delete(entry.target)
        }
      }
    },
    { rootMargin: '200px' }
  )

  return {
    observe(el, cb) {
      if (!el || !cb) return
      callbacks.set(el, cb)
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

const LazyThumbnail = ({ outputPath, dateStr, index, onClick }) => {
  const [b64, setB64] = useState(null)
  const hostRef = useRef(null)
  const observerApi = useContext(ObserverContext)

  useEffect(() => {
    if (!outputPath || !hostRef.current || !observerApi) return
    const el = hostRef.current
    let cancelled = false

    observerApi.observe(el, () => {
      window.electronAPI.getImageBase64(outputPath).then((data) => {
        if (!cancelled) setB64(data)
      })
    })

    return () => {
      cancelled = true
      observerApi.unobserve(el)
    }
  }, [outputPath, observerApi])

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
  const [b64, setB64] = useState(null)
  const closeBtnRef = useRef(null)

  useEffect(() => {
    const item = items[currentIndex]
    if (!item || !item.outputPath) return
    setB64(null)
    window.electronAPI.getImageBase64(item.outputPath).then((data) => {
      setB64(data)
    })
  }, [currentIndex, items])

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
        {b64 ? (
          <img src={`data:image/jpeg;base64,${b64}`} className="fullscreen-img" alt="" />
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
    </ObserverContext.Provider>
  )
}
