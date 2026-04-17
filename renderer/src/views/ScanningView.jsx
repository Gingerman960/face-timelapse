import React, { useEffect, useRef, useState } from 'react'
import useAlignmentStore, { groupByDay } from '../store/alignmentStore'

// Styles moved to src/index.css

export default function ScanningView() {
  const {
    referenceEmbedding, sourceFolderPath,
    scanProgress, setScanProgress,
    candidates, setCandidates,
    setStep, setError,
  } = useAlignmentStore()

  const scanStarted = useRef(false)
  const cancelled = useRef(false)
  const [thumbnails, setThumbnails] = useState([])

  useEffect(() => {
    if (scanStarted.current) return
    scanStarted.current = true

    // Register progress listener
    const unsubscribe = window.electronAPI.onScanProgress((progress) => {
      setScanProgress(progress)
      if (progress.thumbnailBase64) {
        setThumbnails((prev) => {
          const next = [...prev, progress.thumbnailBase64]
          // Limit previews to prevent out-of-memory crashes
          if (next.length > 65) return next.slice(next.length - 65)
          return next
        })
      }
    })

    // Start scan
    window.electronAPI
      .startScan({ folderPath: sourceFolderPath, referenceEmbedding })
      .then((results) => {
        unsubscribe()
        if (cancelled.current) {
          setStep('setup')
          return
        }
        setCandidates(results)
        // Move to confirm if there are uncertain ones, else skip to dailySelection
        const hasUncertain = results.some((c) => c.status === 'uncertain')
        if (hasUncertain) {
          setStep('confirm')
        } else {
          // Compute daily groups before skipping confirm
          const groups = groupByDay(results)
          useAlignmentStore.getState().setDailyGroups(groups)
          setStep('dailySelection')
        }
      })
      .catch((err) => {
        unsubscribe()
        if (err.message?.includes('cancelled')) {
          setStep('setup')
        } else {
          setError(err.message || 'Scan failed')
          setStep('setup')
        }
      })

    return () => {
      unsubscribe()
    }
  }, [])

  const handleCancel = async () => {
    cancelled.current = true
    await window.electronAPI.cancelScan()
    setStep('setup')
  }

  const progress = scanProgress
  const fraction = progress && progress.total > 0 ? progress.index / progress.total : 0
  const pct = Math.round(fraction * 100)

  const confirmed = progress?.confirmed ?? 0
  const uncertain = progress?.uncertain ?? 0
  const cachedHits = progress?.cachedHits ?? 0

  return (
    <div className="view-container">
      <div className="title">Scanning Photos…</div>

      <div className="progress-track m-b-12">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="status-text m-b-24">
        {progress
          ? `Scanning ${progress.filename || ''} (${progress.index + 1} / ${progress.total})`
          : 'Starting…'}
      </div>

      <div className="counters-row m-b-24">
        <div className="scan-counter">
          <div className="counter-num text-success">{confirmed}</div>
          <div className="counter-label">Confirmed</div>
        </div>
        <div className="scan-counter">
          <div className="counter-num text-warning">{uncertain}</div>
          <div className="counter-label">Uncertain</div>
        </div>
        {cachedHits > 0 && (
          <div className="scan-counter">
            <div className="counter-num text-muted">{cachedHits}</div>
            <div className="counter-label">From cache</div>
          </div>
        )}
        <button className="btn btn-danger ml-auto" onClick={handleCancel}>Cancel</button>
      </div>

      {/* Thumbnail grid */}
      <div className="thumb-grid m-b-24">
        {thumbnails.map((b64, i) => (
          <img
            key={i}
            src={`data:image/jpeg;base64,${b64}`}
            className="thumb-img"
            alt=""
          />
        ))}
      </div>
    </div>
  )
}
