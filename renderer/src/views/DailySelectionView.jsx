import React, { useState, useEffect, useMemo } from 'react'
import useAlignmentStore, { getSelectedPhotos } from '../store/alignmentStore'

// Styles moved to src/index.css

export default function DailySelectionView() {
  const {
    dailyGroups, setDailyGroups, setDailyGroupSelection,
    referenceAlignmentPoints, referenceImageSize, referenceOutputSize,
    setAlignedResults, setAlignProgress, setStep, setError,
  } = useAlignmentStore()

  const [activeGroupIdx, setActiveGroupIdx] = useState(null)
  const [thumbCache, setThumbCache] = useState({})
  const [loading, setLoading] = useState(false)

  // Auto-select single-photo days on mount
  useEffect(() => {
    // Single-photo days are already selected (selectedIndex: 0 from groupByDay)
    // Find first multi-photo day to highlight, or stay null if all single
    const firstMulti = dailyGroups.findIndex((g) => g.photos.length > 1)
    if (firstMulti >= 0) setActiveGroupIdx(firstMulti)
    else if (dailyGroups.length > 0) setActiveGroupIdx(0)
  }, [])

  const activeGroup = activeGroupIdx !== null ? dailyGroups[activeGroupIdx] : null

  // Build date→groupIndex lookup
  const dateToGroup = useMemo(() => {
    const map = {}
    dailyGroups.forEach((g, i) => { map[g.date] = i })
    return map
  }, [dailyGroups])

  // Build calendar months from the date range
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

  const loadThumb = async (filePath) => {
    if (thumbCache[filePath]) return
    const b64 = await window.electronAPI.getImageBase64(filePath)
    setThumbCache((c) => ({ ...c, [filePath]: b64 }))
  }

  useEffect(() => {
    if (!activeGroup) return
    for (const photo of activeGroup.photos) {
      loadThumb(photo.filePath)
    }
  }, [activeGroupIdx, activeGroup])

  // Handle clicking an empty day to upload a photo
  const handleUploadForDay = async (dateKey) => {
    const filePath = await window.electronAPI.chooseFile()
    if (!filePath) return

    // Create a new daily group for this date
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

    // Find and activate the new group
    const newIdx = updated.findIndex((g) => g.date === dateKey)
    setActiveGroupIdx(newIdx)
  }

  const handleAlign = async () => {
    const selected = getSelectedPhotos(dailyGroups)
    if (selected.length === 0) {
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
        candidates: selected,
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

  const totalSelected = getSelectedPhotos(dailyGroups).length
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
                <div className="cal-week-row">
                  {DAY_NAMES.map((d) => (
                    <div key={d} className="cal-day-header">{d}</div>
                  ))}
                </div>
                <div className="cal-week-row">
                  {/* Empty cells before first day */}
                  {Array.from({ length: firstDay }, (_, i) => (
                    <div key={`e${i}`} className="cal-day empty" />
                  ))}
                  {/* Day cells */}
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

                    return (
                      <div
                        key={day}
                        className={dayClass}
                        onClick={() => {
                          if (hasPhoto) setActiveGroupIdx(groupIdx)
                          else handleUploadForDay(dateKey)
                        }}
                        title={hasPhoto ? `${group.photos.length} photo${group.photos.length > 1 ? 's' : ''}` : 'Click to add photo'}
                      >
                        {day}
                      </div>
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
              <div className="photo-grid">
                {activeGroup.photos.map((photo, pi) => {
                  const thumb = thumbCache[photo.filePath]
                  const isSelected = pi === activeGroup.selectedIndex
                  return (
                    <div
                      key={photo.filePath}
                      className={`daily-photo-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => setDailyGroupSelection(activeGroupIdx, pi)}
                    >
                      {thumb ? (
                        <img src={`data:image/jpeg;base64,${thumb}`} className="daily-photo-img" alt="" />
                      ) : (
                        <div className="daily-photo-img placeholder" />
                      )}

                      {isSelected && <div className="badge-selected">Selected</div>}

                      <div className="badge-score">
                        {Math.round(photo.similarityScore * 100)}%
                      </div>
                    </div>
                  )
                })}
              </div>
              {/* Selected filename */}
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
