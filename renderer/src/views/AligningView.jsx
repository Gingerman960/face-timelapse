import React, { useState, useEffect } from 'react'
import useAlignmentStore from '../store/alignmentStore'

// Cap on how many aligned previews to keep in renderer memory. Beyond this,
// we drop the oldest entries to avoid OOM on large batches.
const PREVIEW_CAP = 65

export default function AligningView() {
    const { alignProgress, setStep } = useAlignmentStore()
    const [previews, setPreviews] = useState([]) // { filename, b64 }
    const [cancelling, setCancelling] = useState(false)

    useEffect(() => {
        if (!alignProgress?.outputPath) return
        const op = alignProgress.outputPath
        const fn = alignProgress.filename
        // Load as base64 since file:// is blocked by Electron CSP
        window.electronAPI.getImageBase64(op).then((b64) => {
            if (!b64) return
            setPreviews((prev) => {
                // Dedup by outputPath — filename alone collides across source folders.
                if (prev.some((p) => p.outputPath === op)) return prev
                const next = [...prev, { filename: fn, outputPath: op, b64 }]
                if (next.length > PREVIEW_CAP) return next.slice(next.length - PREVIEW_CAP)
                return next
            })
        })
    }, [alignProgress?.outputPath])

    const handleCancel = async () => {
        if (cancelling) return
        setCancelling(true)
        try {
            await window.electronAPI.cancelAlign()
        } finally {
            // The alignBatch promise in DailySelectionView resolves on cancel
            // and routes to 'results'. If it doesn't fire in time, bail manually.
            setTimeout(() => setStep('dailySelection'), 1500)
        }
    }

    const progress = alignProgress
    const fraction = progress && progress.total > 0 ? progress.current / progress.total : 0
    const pct = Math.round(fraction * 100)

    return (
        <div className="view-container">
            <div className="title">Aligning Photos…</div>

            <div className="progress-track m-b-12">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>

            <div className="status-text m-b-24">
                {progress
                    ? `Processing ${progress.filename || ''} (${progress.current} / ${progress.total})`
                    : 'Starting…'}
            </div>

            <div className="counters-row m-b-24">
                <div className="scan-counter">
                    <div className="counter-num text-success">{progress?.current || 0}</div>
                    <div className="counter-label">Aligned</div>
                </div>
                <button className="btn btn-danger ml-auto" onClick={handleCancel} disabled={cancelling}>
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
            </div>

            <div className="thumb-grid m-b-24">
                {previews.map((p, i) => (
                    <img
                        key={p.outputPath || i}
                        src={`data:image/jpeg;base64,${p.b64}`}
                        className="thumb-img"
                        alt={p.filename}
                        title={p.filename}
                    />
                ))}
            </div>
        </div>
    )
}
