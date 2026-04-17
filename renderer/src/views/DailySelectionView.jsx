import React, { useState, useEffect, useMemo, useRef } from 'react'
import useAlignmentStore, { getSelectedPhotos } from '../store/alignmentStore'

// Cap on concurrent getImageBase64 IPC calls. Without this, opening a
// high-count day fires one IPC call per photo in parallel and stalls
// both processes.
const THUMB_LOAD_CONCURRENCY = 4

// Cap thumbnail cache — base64 JPEGs of thousands of photos exhaust renderer memory.
const THUMB_CACHE_CAP = 300

export default function DailySelectionView() {
  const {
    dailyGroups, setDailyGroups, setDailyGroupSelection,
    referenceAlignmentPoints, referenceImageSize, referenceOutputSize,
    setAlignedResults, setAlignProgress, setStep, setError,
  } = useAlignmentStore()

  const [activeGroupIdx, setActiveGroupIdx] = useState(null)
  const [thumbCache, setThumbCache] = useState({})
  const [loading, setLoading] = useState(false)

  // Simple in-memory LRU — order of keys matters for eviction.
  // We re-insert a key on access so it becomes "most recent".
  const touchCacheOrder = (filePath, b64) => {
    setThumbCache((c) => {
      if (c[filePath]) {
        // Re-insert at end (most-recent)
        const rest = { ...c }
        const kept = rest[filePath]
        delete rest[filePath]
        return { ...rest, [filePath]: kept }
      }
      const next = { ...c, [filePath]: b64 }
      const keys = Object.keys(next)
      if (keys.length <= THUMB_CACHE_CAP) return next
      const trimmed = {}
      for (const k of keys.slice(keys.length - THUMB_CACHE_CAP)) trimmed[k] = next[k]
      return trimmed
    })
  }

  // Auto-select single-photo days on mount
  useEffect(() => {
    const firstMulti = dailyGroups.findIndex((g) => g.photos.length > 1)
    if (firstMulti >= 0) setActiveGroupIdx(firstMulti)
    else if (dailyGroups.length > 0) setActiveGroupIdx(0)
  }, [])

  const activeGroup = activeGroupIdx !== null ? dailyGroups[activeGroupIdx] : null

  const dateToGroup = useMemo(() => {
    const map = {}
    dailyGroups.forEach((g, i) => { map[g.date] = i })
    return map
  }, [dailyGroups])

  const calendarMonths = useMemo(() => {
    if (dailyGroups.length === 0) return []
    const dates = dailyGroups.map((g) => g.date).sort()
    const first = dates[0]
    const last = dates[dates.length - 1]
    const [fy, fm] = first.split('-').map(Number)
    const [ly, lm] = last.split('-').map(Number)

    const months = []
    let y = fy, m = fm
    while (y < ly || (y === ly && m <= lm)) {
      const daysInMonth = new Date(y, m, 0).getDate()
      const firstDay = new Date(y, m - 1, 1).getDay() // 0=Sun
      months.push({ year: y, month: m, daysInMonth, firstDay })
      m++
      if (m > 12) { m = 1; y++ }
    }
    return months
  }, [dailyGroups])

  const selectedPhotos = useMemo(() => getSelectedPhotos(dailyGroups), [dailyGroups])
  const totalSelected = selectedPhotos.length

  // Load thumbnails for the active group with a concurrency cap.
  // Ref so StrictMode double-mount doesn't race the queue against itself.
  const loadQueueRef = useRef({ active: 0, pending: [] })

  useEffect(() => {
    if (!activeGroup) return
    const q = loadQueueRef.current

    const pump = () => {
      while (q.active < THUMB_LOAD_CONCURRENCY && q.pending.length > 0) {
        const filePath = q.pending.shift()
        q.active++
        window.electronAPI
          .getImageBase64(filePath)
          .then((b64) => { touchCacheOrder(filePath, b64) })
          .catch(() => {})
          .finally(() => { q.active--; pump() })
      }
    }

    for (const photo of activeGroup.photos) {
      if (thumbCache[photo.filePath]) continue
      // Avoid double-queueing
      if (!q.pending.includes(photo.filePath)) q.pending.push(photo.filePath)
    }
    pump()
  }, [activeGroupIdx, activeGroup])

  const handleUploadForDay = async (dateKey) => {
    const filePath = await window.electronAPI.chooseFile()
    if (!filePath) return

    const newGroup = {
      date: dateKey,
      photos: [{
        filePath,
        filename: filePath.split('/').pop(),
        similarityScore: 1.0,
        status: 'confirmed',
        creationDate: new Date(dateKey + 'T12:00:00').toISOString(),
        embedding: null,
      }],
      selectedIndex: 0,
    }

    const updated = [...dailyGroups, newGroup].sort((a, b) => a.date.localeCompare(b.date))
    setDailyGroups(updated)

    const newIdx = updated.findIndex((g) => g.date === dateKey)
    setActiveGroupIdx(newIdx)
  }

  const handleAlign = async () => {
    if (selectedPhotos.length === 0) {
      setError('No photos selected')
      return
    }

    setStep('aligning')
    setLoading(true)

    const unsubscribe = window.electronAPI.onAlignProgress((progress) => {
      setAlignProgress(progress)
    })

    try {
      const results = await window.electronAPI.alignBatch({
        candidates: selectedPhotos,
        referenceAlignmentPoints,
        referenceImageSize,
        outputSize: referenceOutputSize,
      })
      setAlignedResults(results.filter((r) => r.outputPath))
      unsubscribe()
      setStep('results')
    } catch (err) {
      unsubscribe()
      setError(err.message || 'Alignment failed')
      setStep('dailySelection')
    } finally {
      setLoading(false)
    }
  }

  const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

  return (
    <div className="daily-layout">
      <div className="daily-container">
        {/* Sidebar: calendar */}
        <div className="daily-sidebar">
          <div className="sidebar-title">Calendar ({dailyGroups.length} days)</div>

          <div className="cal-legend">
            <span><span className="cal-legend-dot dot-single" />1 photo</span>
            <span><span className="cal-legend-dot dot-multi" />multiple</span>
          </div>

          {calendarMonths.map(({ year, month, daysInMonth, firstDay }) => {
            const monthStr = new Date(year, month - 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
            return (
              <div key={`${year}-${month}`} className="cal-month">
                <div className="cal-month-header">{monthStr}</div>
                <div className="cal-week-row" role="row">
                  {DAY_NAMES.map((d) => (
                    <div key={d} className="cal-day-header" role="columnheader">{d}</div>
                  ))}
                </div>
                <div className="cal-week-row" role="row">
                  {Array.from({ length: firstDay }, (_, i) => (
                    <div key={`e${i}`} className="cal-day empty" aria-hidden="true" />
                  ))}
                  {Array.from({ length: daysInMonth }, (_, i) => {
                    const day = i + 1
                    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                    const groupIdx = dateToGroup[dateKey]
                    const hasPhoto = groupIdx !== undefined
                    const group = hasPhoto ? dailyGroups[groupIdx] : null
                    const isMulti = group && group.photos.length > 1
                    const isActive = groupIdx === activeGroupIdx

                    let dayClass = 'cal-day'
                    if (hasPhoto) dayClass += isMulti ? ' has-multi' : ' has-single'
                    if (isActive) dayClass += ' active'

                    const label = hasPhoto
                      ? `${monthStr} ${day} — ${group.photos.length} photo${group.photos.length > 1 ? 's' : ''}`
                      : `${monthStr} ${day} — no photo, click to add`

                    return (
                      <button
                        type="button"
                        key={day}
                        className={dayClass}
                        onClick={() => {
                          if (hasPhoto) setActiveGroupIdx(groupIdx)
                          else handleUploadForDay(dateKey)
                        }}
                        aria-label={label}
                        aria-pressed={isActive}
                      >
                        {day}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        {/* Main: photos for selected day */}
        <div className="daily-main">
          {activeGroup ? (
            <>
              <div className="main-title">
                {formatDate(activeGroup.date)}
                {activeGroup.photos.length === 1
                  ? <span className="text-muted font-normal"> — Auto-selected</span>
                  : <span className="text-muted font-normal"> — Pick one ({activeGroup.photos.length} photos)</span>}
              </div>
              <div className="photo-grid" role="radiogroup" aria-label="Photos for selected day">
                {activeGroup.photos.map((photo, pi) => {
                  const thumb = thumbCache[photo.filePath]
                  const isSelected = pi === activeGroup.selectedIndex
                  const pct = Math.round(photo.similarityScore * 100)
                  return (
                    <button
                      type="button"
                      key={photo.filePath}
                      className={`daily-photo-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => setDailyGroupSelection(activeGroupIdx, pi)}
                      role="radio"
                      aria-checked={isSelected}
                      aria-label={`${photo.filename}, ${pct}% similarity${isSelected ? ', selected' : ''}`}
                    >
                      {thumb ? (
                        <img src={`data:image/jpeg;base64,${thumb}`} className="daily-photo-img" alt="" />
                      ) : (
                        <div className="daily-photo-img placeholder" aria-hidden="true" />
                      )}

                      {isSelected && <div className="badge-selected">Selected</div>}

                      <div className="badge-score">{pct}%</div>
                    </button>
                  )
                })}
              </div>
              {activeGroup.photos[activeGroup.selectedIndex] && (
                <div className="daily-filename">
                  Selected: {activeGroup.photos[activeGroup.selectedIndex].filename}
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">Select a day from the calendar to view photos.</div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="daily-footer">
        <button
          className="btn btn-secondary"
          onClick={() => setStep('setup')}
        >
          Back
        </button>
        <div className="footer-info">{totalSelected} photo{totalSelected !== 1 ? 's' : ''} to align</div>
        <button
          className="btn btn-primary"
          onClick={handleAlign}
          disabled={totalSelected === 0 || loading}
        >
          {loading ? 'Aligning…' : `Align ${totalSelected} Photos`}
        </button>
      </div>
    </div>
  )
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-')
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  })
}
