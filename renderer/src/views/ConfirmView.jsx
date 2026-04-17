import React, { useState, useEffect, useCallback } from 'react'
import useAlignmentStore, { groupByDay } from '../store/alignmentStore'

// Styles moved to src/index.css

export default function ConfirmView() {
  const { candidates, setCandidateStatus, setDailyGroups, setStep } = useAlignmentStore()

  const uncertain = candidates
    .map((c, i) => ({ ...c, originalIndex: i }))
    .filter((c) => c.status === 'uncertain')

  const [reviewIdx, setReviewIdx] = useState(0)
  const [initialTotal] = useState(uncertain.length)
  const [thumbs, setThumbs] = useState({}) // filePath → base64

  const current = uncertain[0]

  // Keep the thumbnail cache bounded — base64 JPEGs add up fast on long review sessions.
  const THUMB_CACHE_CAP = 30

  // Load thumbnail for current
  useEffect(() => {
    if (!current) return
    if (thumbs[current.filePath]) return
    window.electronAPI.getImageBase64(current.filePath).then((b64) => {
      setThumbs((t) => {
        const next = { ...t, [current.filePath]: b64 }
        const keys = Object.keys(next)
        if (keys.length <= THUMB_CACHE_CAP) return next
        // Drop oldest keys (insertion order is preserved in modern JS engines)
        const trimmed = {}
        for (const k of keys.slice(keys.length - THUMB_CACHE_CAP)) trimmed[k] = next[k]
        return trimmed
      })
    })
  }, [current?.filePath])

  const handleConfirm = useCallback(() => {
    if (!current) return
    setCandidateStatus(current.originalIndex, 'confirmed')
    setReviewIdx((i) => i + 1)
  }, [current, setCandidateStatus])

  const handleReject = useCallback(() => {
    if (!current) return
    setCandidateStatus(current.originalIndex, 'rejected')
    setReviewIdx((i) => i + 1)
  }, [current, setCandidateStatus])

  const handleDone = () => {
    const updatedCandidates = useAlignmentStore.getState().candidates
    const groups = groupByDay(updatedCandidates)
    setDailyGroups(groups)
    setStep('dailySelection')
  }

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'ArrowRight' || e.key === 'Enter') handleConfirm()
    if (e.key === 'ArrowLeft' || e.key === 'Backspace') handleReject()
  }, [handleConfirm, handleReject])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Auto-advance when all uncertain photos have been reviewed
  useEffect(() => {
    if (uncertain.length === 0) {
      const updatedCandidates = useAlignmentStore.getState().candidates
      const groups = groupByDay(updatedCandidates)
      setDailyGroups(groups)
      setStep('dailySelection')
    }
  }, [uncertain.length])

  const scoreColor = (score) => {
    if (score >= 0.60) return '#00cc66'
    if (score >= 0.40) return '#f0a030'
    return '#cc3333'
  }

  // While transitioning, render nothing
  if (!current) return null

  const b64 = thumbs[current.filePath]
  const pct = Math.round(current.similarityScore * 100)

  return (
    <div className="view-container flex-col">
      <div className="title m-b-8">
        Review Uncertain Matches
        <span className="badge badge-warning ml-8">uncertain</span>
      </div>
      <div className="subtitle text-muted m-b-24">
        Press → or Enter to confirm, ← or Backspace to reject
      </div>
      <div className="counter-text m-b-24">
        {Math.min(reviewIdx + 1, initialTotal)} of {initialTotal} uncertain photos
      </div>

      <div className="glass-panel confirm-card m-b-24">
        {b64 ? (
          <img src={`data:image/jpeg;base64,${b64}`} className="confirm-img" alt="" />
        ) : (
          <div className="confirm-img placeholder">
            Loading…
          </div>
        )}

        <div className="confirm-info">
          <div className="filename-text m-b-6">{current.filename}</div>
          <div className="score-text m-b-12" style={{ color: scoreColor(current.similarityScore) }}>
            {pct}% similarity
          </div>
          <div className="date-text m-b-16">
            {new Date(current.creationDate).toLocaleDateString()}
          </div>
          <div className="btn-row">
            <button className="btn btn-confirm" onClick={handleConfirm}>
              Confirm (→)
            </button>
            <button className="btn btn-reject" onClick={handleReject}>
              Reject (←)
            </button>
          </div>
        </div>
      </div>

      <button
        className="btn btn-primary btn-done mt-auto"
        onClick={handleDone}
      >
        Done Reviewing
      </button>
      <div className="hint-text mt-12">You can stop reviewing early — remaining uncertain photos will be excluded.</div>
    </div>
  )
}
