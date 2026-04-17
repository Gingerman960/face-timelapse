import React, { useState, useEffect, useRef } from 'react'
import useAlignmentStore from '../store/alignmentStore'

export default function VideoExportModal({ onClose }) {
    const { alignedResults, videoProgress, setVideoProgress, setError } = useAlignmentStore()

    const count = alignedResults.length

    const [fps, setFps] = useState(10)
    const [duration, setDuration] = useState(count > 0 ? count / 10 : 0)
    const [exporting, setExporting] = useState(false)

    const dialogRef = useRef(null)
    const firstFocusRef = useRef(null)

    useEffect(() => {
        setVideoProgress(null)
    }, [setVideoProgress])

    // Close on Escape (only when not mid-export).
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape' && !exporting) onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [exporting, onClose])

    // Focus the first interactive element in the dialog on open so keyboard
    // users land inside it instead of behind it.
    useEffect(() => {
        firstFocusRef.current?.focus()
    }, [])

    // Basic focus trap: when the user tabs past the last focusable element,
    // wrap back to the first (and vice versa for shift-tab).
    useEffect(() => {
        const dialog = dialogRef.current
        if (!dialog) return

        const handleKey = (e) => {
            if (e.key !== 'Tab') return
            const focusables = dialog.querySelectorAll(
                'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
            )
            if (focusables.length === 0) return
            const first = focusables[0]
            const last = focusables[focusables.length - 1]

            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault()
                last.focus()
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault()
                first.focus()
            }
        }

        dialog.addEventListener('keydown', handleKey)
        return () => dialog.removeEventListener('keydown', handleKey)
    }, [])

    const handleFpsChange = (newFps) => {
        setFps(newFps)
        if (newFps > 0 && count > 0) setDuration(count / newFps)
    }

    const handleDurationChange = (newDuration) => {
        setDuration(newDuration)
        if (newDuration > 0 && count > 0) setFps(count / newDuration)
    }

    const handleExport = async () => {
        const outputPath = await window.electronAPI.savePath({
            defaultName: `facetimelapse_${Date.now()}.mp4`,
            filters: [{ name: 'Video', extensions: ['mp4'] }],
        })
        if (!outputPath) return

        setExporting(true)
        setVideoProgress(null)

        const unsubscribe = window.electronAPI.onVideoProgress((p) => {
            setVideoProgress(p)
        })

        try {
            const imagePaths = alignedResults.map((r) => r.outputPath)
            await window.electronAPI.exportVideo({
                imagePaths,
                outputPath,
                fps: Number(fps.toFixed(2)),
                totalDuration: Number(duration.toFixed(2)),
            })
            setVideoProgress({ percent: 100, timemark: 'done' })
        } catch (err) {
            setError(err.message || 'Video export failed')
        } finally {
            unsubscribe()
            setExporting(false)
        }
    }

    const pct = videoProgress?.percent ? Math.min(100, Math.round(videoProgress.percent)) : 0

    return (
        <div
            className="modal-overlay"
            onClick={() => { if (!exporting) onClose() }}
            role="presentation"
        >
            <div
                ref={dialogRef}
                className="modal-content"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="video-modal-title"
            >
                <div className="title" id="video-modal-title">Create Timelapse Video</div>

                <div className="modal-section m-b-24">
                    <div className="m-b-24">
                        <label className="modal-label" htmlFor="fps-slider">Framerate (FPS)</label>
                        <input
                            id="fps-slider"
                            ref={firstFocusRef}
                            type="range"
                            min={1} max={60} step={1} value={fps}
                            onChange={(e) => handleFpsChange(Number(e.target.value))}
                            className="input-range"
                            disabled={exporting}
                        />
                        <div className="slider-value">{fps.toFixed(1)} FPS</div>
                    </div>

                    <div>
                        <label className="modal-label" htmlFor="duration-slider">Total Duration</label>
                        <input
                            id="duration-slider"
                            type="range"
                            min={1} max={120} step={1} value={duration}
                            onChange={(e) => handleDurationChange(Number(e.target.value))}
                            className="input-range"
                            disabled={exporting}
                        />
                        <div className="slider-value">{duration.toFixed(1)}s</div>
                    </div>
                </div>

                {(exporting || (videoProgress && videoProgress.percent > 0)) && (
                    <div className="modal-section" style={{ marginTop: 24 }}>
                        <div className="export-msg">
                            {videoProgress?.percent === 100
                                ? 'Export complete!'
                                : `Encoding… ${pct}%`}
                        </div>
                        <div className="progress-track">
                            <div className="progress-fill" style={{ width: `${pct}%` }} />
                        </div>
                    </div>
                )}

                <div className="modal-btn-row">
                    <button
                        className="btn btn-secondary"
                        onClick={videoProgress?.percent === 100 ? onClose : () => { if (!exporting) onClose() }}
                        disabled={exporting && videoProgress?.percent !== 100}
                    >
                        {videoProgress?.percent === 100 ? 'Close' : 'Cancel'}
                    </button>
                    {!videoProgress || videoProgress.percent !== 100 ? (
                        <button
                            className="btn btn-primary"
                            onClick={handleExport}
                            disabled={exporting || count < 2}
                        >
                            {exporting ? 'Exporting…' : 'Export MP4'}
                        </button>
                    ) : null}
                </div>
            </div>
        </div>
    )
}
