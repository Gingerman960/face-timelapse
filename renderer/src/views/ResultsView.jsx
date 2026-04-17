import React, { useState, useEffect, useRef } from 'react'
import useAlignmentStore from '../store/alignmentStore'
import VideoExportModal from '../components/VideoExportModal'

// Styles moved to src/index.css

const LazyThumbnail = ({ outputPath, dateStr, index, onClick }) => {
  const [b64, setB64] = useState(null)
  const imgRef = useRef(null)

  useEffect(() => {
    if (!outputPath) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        window.electronAPI.getImageBase64(outputPath).then((data) => {
          setB64(data)
        })
        observer.disconnect()
      }
    }, { rootMargin: '200px' })

    if (imgRef.current) observer.observe(imgRef.current)

    return () => observer.disconnect()
  }, [outputPath])

  return (
    <div className="results-card" ref={imgRef} onClick={() => onClick(index)} style={{ cursor: 'pointer' }}>
      {b64 ? (
        <img src={`data:image/jpeg;base64,${b64}`} className="results-img" alt="" />
      ) : (
        <div className="results-img placeholder">Loading</div>
      )}
      <div className="date-badge">{dateStr}</div>
    </div>
  )
}

const FullscreenViewer = ({ items, initialIndex, onClose }) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex)
  const [b64, setB64] = useState(null)

  useEffect(() => {
    const item = items[currentIndex]
    if (!item || !item.outputPath) return
    setB64(null) // Clear immediately when switching
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
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [items.length, onClose])

  const currentItem = items[currentIndex]
  const dateStr = currentItem?.creationDate ? new Date(currentItem.creationDate).toLocaleString() : ''

  return (
    <div className="fullscreen-overlay" onClick={onClose}>
      <div className="fullscreen-content" onClick={(e) => e.stopPropagation()}>
        {b64 ? (
          <img src={`data:image/jpeg;base64,${b64}`} className="fullscreen-img" alt="" />
        ) : (
          <div className="fullscreen-img placeholder text-muted">Loading high-res image…</div>
        )}

        <div className="fullscreen-topbar">
          <span>{currentIndex + 1} / {items.length}</span>
          <span>{dateStr}</span>
          <button className="fullscreen-close" onClick={onClose}>×</button>
        </div>

        {currentIndex > 0 && (
          <div className="nav-zone nav-left" onClick={() => setCurrentIndex(currentIndex - 1)}>
            <span className="nav-arrow">‹</span>
          </div>
        )}
        {currentIndex < items.length - 1 && (
          <div className="nav-zone nav-right" onClick={() => setCurrentIndex(currentIndex + 1)}>
            <span className="nav-arrow">›</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default function ResultsView() {
  const {
    alignedResults, setStep, setError, setVideoProgress,
  } = useAlignmentStore()

  const [exportProgress, setExportProgressLocal] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [showVideoModal, setShowVideoModal] = useState(false)
  const [viewerIndex, setViewerIndex] = useState(null)

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
  )
}
