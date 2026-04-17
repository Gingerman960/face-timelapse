import React, { useState, useEffect } from 'react'
import useAlignmentStore from '../store/alignmentStore'

// Styles moved to src/index.css

export default function AligningView() {
    const { alignProgress } = useAlignmentStore()
    const [previews, setPreviews] = useState([]) // { filename, b64 }

    useEffect(() => {
        if (!alignProgress?.outputPath) return
        const op = alignProgress.outputPath
        const fn = alignProgress.filename
        // Load as base64 since file:// is blocked by Electron CSP
        window.electronAPI.getImageBase64(op).then((b64) => {
            if (!b64) return
            setPreviews((prev) => {
                if (prev.some((p) => p.filename === fn)) return prev
                // Limit previews to prevent out-of-memory crashes
                const next = [...prev, { filename: fn, b64 }]
                if (next.length > 65) return next.slice(next.length - 65)
                return next
            })
        })
    }, [alignProgress?.outputPath])

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
            </div>

            <div className="thumb-grid m-b-24">
                {previews.map((p, i) => (
                    <img
                        key={i}
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
