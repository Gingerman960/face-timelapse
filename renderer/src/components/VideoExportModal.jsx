import React, { useState, useEffect } from 'react'
import useAlignmentStore from '../store/alignmentStore'

// Styles moved to src/index.css

export default function VideoExportModal({ onClose }) {
    const { alignedResults, videoProgress, setVideoProgress, setError } = useAlignmentStore()

    const count = alignedResults.length

    const [fps, setFps] = useState(10)
    const [duration, setDuration] = useState(count > 0 ? count / 10 : 0)
    const [exporting, setExporting] = useState(false)
    useEffect(() => {
        // Reset video progress when modal opens
        setVideoProgress(null)
    }, [setVideoProgress])

    const handleFpsChange = (newFps) => {
        setFps(newFps)
        if (newFps > 0) setDuration(count / newFps)
    }

    const handleDurationChange = (newDuration) => {
        setDuration(newDuration)
        if (newDuration > 0) setFps(count / newDuration)
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
        <div className="modal-overlay">
            <div className="modal-content">
                <div className="title">Create Timelapse Video</div>

                <div className="modal-section m-b-24">
                    {/* FPS slider */}
                    <div className="m-b-24">
                        <label className="modal-label">Framerate (FPS)</label>
                        <input
                            type="range"
                            min={1} max={60} step={1} value={fps}
                            onChange={(e) => handleFpsChange(Number(e.target.value))}
                            className="input-range"
                            disabled={exporting}
                        />
                        <div className="slider-value">{fps.toFixed(1)} FPS</div>
                    </div>

                    {/* Duration slider */}
                    <div>
                        <label className="modal-label">Total Duration</label>
                        <input
                            type="range"
                            min={1} max={120} step={1} value={duration}
                            onChange={(e) => handleDurationChange(Number(e.target.value))}
                            className="input-range"
                            disabled={exporting}
                        />
                        <div className="slider-value">{duration.toFixed(1)}s</div>
                    </div>
                </div>

                {/* Progress */}
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

                {/* Buttons */}
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
