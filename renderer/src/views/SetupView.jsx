import React, { useRef, useState, useEffect, useCallback } from 'react'
import useAlignmentStore from '../store/alignmentStore'

const ASPECT_RATIOS = ['free', '1:1', '4:3', '16:9', '9:16', '3:4']
const OUTPUT_SIZES = {
  '1:1': { w: 512, h: 512 },
  '4:3': { w: 512, h: 384 },
  '16:9': { w: 512, h: 288 },
  '9:16': { w: 288, h: 512 },
  '3:4': { w: 384, h: 512 },
}

// For 'free', compute output size from crop dimensions, capping longest side at 512
function getOutputSize(ar, cropW, cropH) {
  if (ar !== 'free' && OUTPUT_SIZES[ar]) return OUTPUT_SIZES[ar]
  const ratio = cropW / cropH
  if (ratio >= 1) return { w: 512, h: Math.round(512 / ratio) }
  return { w: Math.round(512 * ratio), h: 512 }
}

// Get the target aspect ratio for locking crop handles (null for free)
function getTargetAR(ar) {
  if (ar === 'free' || !OUTPUT_SIZES[ar]) return null
  const { w, h } = OUTPUT_SIZES[ar]
  return w / h
}

const PREVIEW_MAX = 380
const HANDLE_SIZE = 10   // visual square size
const HANDLE_HIT = 18   // hit-test radius
const MIN_CROP = 30   // minimum crop dimension in preview px

// Handle definitions — cx/cy are fractional offsets within the crop box (0..1)
const HANDLE_DEFS = [
  { name: 'nw', cx: 0, cy: 0, cursor: 'nwse-resize' },
  { name: 'n', cx: 0.5, cy: 0, cursor: 'ns-resize' },
  { name: 'ne', cx: 1, cy: 0, cursor: 'nesw-resize' },
  { name: 'e', cx: 1, cy: 0.5, cursor: 'ew-resize' },
  { name: 'se', cx: 1, cy: 1, cursor: 'nwse-resize' },
  { name: 's', cx: 0.5, cy: 1, cursor: 'ns-resize' },
  { name: 'sw', cx: 0, cy: 1, cursor: 'nesw-resize' },
  { name: 'w', cx: 0, cy: 0.5, cursor: 'ew-resize' },
]

function getHandles(box) {
  return HANDLE_DEFS.map((h) => ({
    ...h,
    px: box.x + h.cx * box.w,
    py: box.y + h.cy * box.h,
  }))
}

function hitTestHandles(x, y, box) {
  for (const h of getHandles(box)) {
    if (Math.abs(x - h.px) <= HANDLE_HIT / 2 && Math.abs(y - h.py) <= HANDLE_HIT / 2) {
      return h
    }
  }
  return null
}

function clampBox(x, y, w, h, maxW, maxH) {
  w = Math.max(MIN_CROP, w)
  h = Math.max(MIN_CROP, h)
  x = Math.max(0, Math.min(maxW - w, x))
  y = Math.max(0, Math.min(maxH - h, y))
  w = Math.min(w, maxW - x)
  h = Math.min(h, maxH - y)
  return { x, y, w, h }
}

// Largest crop box for the given aspect ratio, centered on (cx, cy), clamped to image bounds.
function computeARCrop(cx, cy, pw, ph, ar) {
  if (ar === 'free' || !OUTPUT_SIZES[ar]) {
    // Free-form: use full image (also handles stale/unknown AR values)
    return { x: 0, y: 0, w: pw, h: ph }
  }
  const { w: ow, h: oh } = OUTPUT_SIZES[ar]
  const targetAR = ow / oh
  let cw = pw
  let ch = cw / targetAR
  if (ch > ph) { ch = ph; cw = ch * targetAR }
  cw = Math.round(cw)
  ch = Math.round(ch)
  return {
    x: Math.max(0, Math.min(pw - cw, Math.round(cx - cw / 2))),
    y: Math.max(0, Math.min(ph - ch, Math.round(cy - ch / 2))),
    w: cw, h: ch,
  }
}

// Styles moved to src/index.css

export default function SetupView() {
  const {
    referenceImagePath, referencePreviewBase64, referenceLandmarks68,
    referenceImageSize, cropParams, setCropParams,
    aspectRatio, setAspectRatio,
    sourceFolderPath, setSourceFolderPath,
    setReferenceImagePath, setReferenceResult,
    setError, setStep, referenceEmbedding,
  } = useAlignmentStore()

  const [loading, setLoading] = useState(false)
  const [aligningFace, setAligningFace] = useState(false)
  const [centeringFace, setCenteringFace] = useState(false)
  const [rawImageSize, setRawImageSize] = useState(null)
  const [previewSize, setPreviewSize] = useState({ w: PREVIEW_MAX, h: PREVIEW_MAX })
  const [cropBox, setCropBox] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [cursor, setCursor] = useState('default')

  const imgRef = useRef(null)
  const originalImagePathRef = useRef(null) // original file before any alignment
  const dragRef = useRef(null)         // drag state (not React state — no re-render needed)
  const cropBoxRef = useRef(null)         // mirror of cropBox for use inside handlers
  const previewSizeRef = useRef(previewSize)
  const aspectRatioRef = useRef(aspectRatio)  // lets image-load closure read latest AR without re-running

  // Keep refs in sync — defined first so they run before dependent effects
  useEffect(() => { cropBoxRef.current = cropBox }, [cropBox])
  useEffect(() => { previewSizeRef.current = previewSize }, [previewSize])
  useEffect(() => { aspectRatioRef.current = aspectRatio }, [aspectRatio])

  // Load image — initialise crop to max AR-constrained box centered in the image
  useEffect(() => {
    if (!referenceImagePath) {
      setRawImageSize(null)
      setCropBox(null)
      return
    }
    const img = new window.Image()
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      setRawImageSize({ w, h })
      const ratio = w / h
      const pw = Math.min(PREVIEW_MAX, w)
      const ph = Math.round(pw / ratio)
      setPreviewSize({ w: pw, h: ph })
      // Use ref so we get the current AR without adding it as a dep (which would re-load on AR change)
      setCropBox(computeARCrop(pw / 2, ph / 2, pw, ph, aspectRatioRef.current))
    }
    img.src = `safe-file://${referenceImagePath}`
  }, [referenceImagePath])

  // When aspect ratio changes: reshape the crop box, keeping its current center
  useEffect(() => {
    setCropBox((prev) => {
      if (!prev) return prev
      const ps = previewSizeRef.current
      const cx = prev.x + prev.w / 2
      const cy = prev.y + prev.h / 2
      return computeARCrop(cx, cy, ps.w, ps.h, aspectRatio)
    })
  }, [aspectRatio])

  // ---- Actions ----

  const handleChooseReference = async () => {
    const filePath = await window.electronAPI.chooseFile()
    if (filePath) {
      originalImagePathRef.current = filePath
      setReferenceImagePath(filePath)
      setCropParams(null)
    }
  }

  const handleChooseFolder = async () => {
    const folder = await window.electronAPI.chooseFolder()
    if (folder) setSourceFolderPath(folder)
  }

  const handleSetReference = useCallback(async () => {
    if (!referenceImagePath || loading) return
    setLoading(true)
    try {
      let pixelCrop = null
      if (cropBox && rawImageSize) {
        const scaleX = rawImageSize.w / previewSize.w
        const scaleY = rawImageSize.h / previewSize.h
        const fullW = Math.abs(cropBox.w - previewSize.w) < 2
        const fullH = Math.abs(cropBox.h - previewSize.h) < 2
        if (!(cropBox.x === 0 && cropBox.y === 0 && fullW && fullH)) {
          pixelCrop = {
            x: Math.round(cropBox.x * scaleX),
            y: Math.round(cropBox.y * scaleY),
            width: Math.round(cropBox.w * scaleX),
            height: Math.round(cropBox.h * scaleY),
          }
        }
      }
      const result = await window.electronAPI.setReference({
        imagePath: referenceImagePath,
        cropParams: pixelCrop,
        aspectRatio,
      })
      setReferenceResult(result)
    } catch (err) {
      setError(err.message || 'Failed to set reference photo')
    } finally {
      setLoading(false)
    }
  }, [referenceImagePath, cropBox, rawImageSize, previewSize, aspectRatio])

  // Auto-trigger reference setting when photo/crop/aspect ratio changes (debounced)
  useEffect(() => {
    if (!referenceImagePath || !cropBox || isDragging) return
    const timer = setTimeout(() => {
      handleSetReference()
    }, 500)
    return () => clearTimeout(timer)
  }, [referenceImagePath, cropBox, aspectRatio, isDragging, handleSetReference])

  const handleStartScan = () => {
    if (!referenceEmbedding || !sourceFolderPath) return
    setStep('scanning')
  }

  const handleReset = () => {
    // Restore original image (undo alignment), reset crop
    if (originalImagePathRef.current && originalImagePathRef.current !== referenceImagePath) {
      setReferenceImagePath(originalImagePathRef.current)
    } else if (previewSize.w) {
      setCropBox(computeARCrop(previewSize.w / 2, previewSize.h / 2, previewSize.w, previewSize.h, aspectRatio))
    }
  }

  // Align Face: straighten the image so eyes are level
  const handleAlignFace = async () => {
    if (!referenceImagePath || !rawImageSize || aligningFace) return
    setAligningFace(true)
    try {
      const result = await window.electronAPI.detectFaceBounds(referenceImagePath)
      if (!result) return

      const { leftEye, rightEye } = result
      const dx = rightEye.x - leftEye.x
      const dy = rightEye.y - leftEye.y
      const angleDeg = -(Math.atan2(dy, dx) * 180) / Math.PI

      if (Math.abs(angleDeg) > 0.3) {
        const straightened = await window.electronAPI.straightenImage({
          imagePath: referenceImagePath,
          angleDegrees: angleDeg,
        })
        setReferenceImagePath(straightened.filePath)
      }
    } catch {
      // silently keep current image
    } finally {
      setAligningFace(false)
    }
  }

  // Center Face: move the current crop box so the face is at its center (keep current dimensions)
  const handleCenterFace = async () => {
    if (!referenceImagePath || !rawImageSize || !cropBox || centeringFace) return
    setCenteringFace(true)
    try {
      const result = await window.electronAPI.detectFaceBounds(referenceImagePath)
      if (!result) return

      const { faceBox, imageSize } = result
      const scaleX = previewSize.w / imageSize.w
      const scaleY = previewSize.h / imageSize.h

      // Face center in preview coords
      const faceCx = (faceBox.x + faceBox.w / 2) * scaleX
      const faceCy = (faceBox.y + faceBox.h / 2) * scaleY

      // Max crop size that keeps face exactly centered (constrained by distance to edges)
      const maxW = Math.min(faceCx, previewSize.w - faceCx) * 2
      const maxH = Math.min(faceCy, previewSize.h - faceCy) * 2

      let cw = cropBox.w, ch = cropBox.h
      const lockedAR = getTargetAR(aspectRatio)

      if (cw > maxW || ch > maxH) {
        // Need to shrink to fit — respect AR lock
        if (lockedAR) {
          cw = Math.min(cw, maxW)
          ch = Math.round(cw / lockedAR)
          if (ch > maxH) { ch = maxH; cw = Math.round(ch * lockedAR) }
        } else {
          cw = Math.min(cw, maxW)
          ch = Math.min(ch, maxH)
        }
      }

      const nx = Math.round(faceCx - cw / 2)
      const ny = Math.round(faceCy - ch / 2)
      setCropBox(clampBox(nx, ny, cw, ch, previewSize.w, previewSize.h))
    } catch {
      // silently keep current crop
    } finally {
      setCenteringFace(false)
    }
  }

  // ---- Crop drag handlers ----

  const handleMouseDown = (e) => {
    if (!cropBoxRef.current || !rawImageSize) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const box = cropBoxRef.current

    const handle = hitTestHandles(x, y, box)
    if (handle) {
      dragRef.current = { mode: handle.name, cursor: handle.cursor, startX: x, startY: y, origBox: { ...box } }
      setCursor(handle.cursor)
      setIsDragging(true)
    } else if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
      dragRef.current = { mode: 'move', cursor: 'grabbing', startX: x, startY: y, origBox: { ...box } }
      setCursor('grabbing')
      setIsDragging(true)
    }
  }

  const handleMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const ps = previewSizeRef.current

    if (dragRef.current) {
      const { mode, startX, startY, origBox } = dragRef.current
      const dx = x - startX
      const dy = y - startY
      let nx = origBox.x, ny = origBox.y, nw = origBox.w, nh = origBox.h
      const lockedAR = getTargetAR(aspectRatioRef.current)

      if (mode === 'move') {
        nx = origBox.x + dx
        ny = origBox.y + dy
      } else if (lockedAR) {
        // AR-locked resize: use the dominant drag axis to resize, constrain the other
        const isCorner = mode.length === 2
        const hasN = mode.includes('n'), hasS = mode.includes('s')
        const hasW = mode.includes('w'), hasE = mode.includes('e')

        if (isCorner) {
          // Corner drag: use dx to drive width, compute height from AR
          if (hasE) { nw = origBox.w + dx } else if (hasW) { nw = origBox.w - dx }
          nw = Math.max(MIN_CROP, nw)
          nh = Math.round(nw / lockedAR)
          nh = Math.max(MIN_CROP, nh)
          nw = Math.round(nh * lockedAR)
          if (hasW) nx = origBox.x + origBox.w - nw
          if (hasN) ny = origBox.y + origBox.h - nh
        } else if (hasE || hasW) {
          // Horizontal edge: width drives height
          if (hasE) { nw = origBox.w + dx } else { nw = origBox.w - dx }
          nw = Math.max(MIN_CROP, nw)
          nh = Math.round(nw / lockedAR)
          if (hasW) nx = origBox.x + origBox.w - nw
          // Keep vertical center
          ny = origBox.y + (origBox.h - nh) / 2
        } else {
          // Vertical edge: height drives width
          if (hasS) { nh = origBox.h + dy } else { nh = origBox.h - dy }
          nh = Math.max(MIN_CROP, nh)
          nw = Math.round(nh * lockedAR)
          if (hasN) ny = origBox.y + origBox.h - nh
          // Keep horizontal center
          nx = origBox.x + (origBox.w - nw) / 2
        }
      } else {
        // Free resize (no AR lock)
        if (mode.includes('n')) {
          ny = origBox.y + dy
          nh = origBox.h - dy
          if (nh < MIN_CROP) { nh = MIN_CROP; ny = origBox.y + origBox.h - MIN_CROP }
        }
        if (mode.includes('s')) {
          nh = origBox.h + dy
          if (nh < MIN_CROP) nh = MIN_CROP
        }
        if (mode.includes('w')) {
          nx = origBox.x + dx
          nw = origBox.w - dx
          if (nw < MIN_CROP) { nw = MIN_CROP; nx = origBox.x + origBox.w - MIN_CROP }
        }
        if (mode.includes('e')) {
          nw = origBox.w + dx
          if (nw < MIN_CROP) nw = MIN_CROP
        }
      }

      setCropBox(clampBox(nx, ny, nw, nh, ps.w, ps.h))
      return
    }

    // Not dragging — update hover cursor
    const box = cropBoxRef.current
    if (!box) return
    const handle = hitTestHandles(x, y, box)
    if (handle) {
      setCursor(handle.cursor)
    } else if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
      setCursor('move')
    } else {
      setCursor('default')
    }
  }

  const handleMouseUp = () => {
    if (dragRef.current) {
      dragRef.current = null
      setIsDragging(false)
      setCursor('default')
    }
  }

  const canSetReference = !!referenceImagePath && !loading
  const canStartScan = !!referenceEmbedding && !!sourceFolderPath
  const handles = cropBox ? getHandles(cropBox) : []

  return (
    <div className="view-container split-view">

      {/* ── Left panel: reference photo ── */}
      <div className="split-panel">
        <div className="setup-section">
          <div className="subtitle">Reference Photo</div>

          <button
            className="btn btn-secondary m-b-12"
            onClick={handleChooseReference}
          >
            Choose Reference Photo
          </button>

          {referenceImagePath && (
            <div className="m-b-12">
              <div className="path-display">{referenceImagePath}</div>

              {/* ── Crop canvas ── */}
              <div
                className="crop-container"
                style={{
                  width: previewSize.w,
                  height: previewSize.h,
                  cursor,
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              >
                {/* Base image */}
                <img
                  ref={imgRef}
                  src={`safe-file://${referenceImagePath}`}
                  style={{ width: previewSize.w, height: previewSize.h, display: 'block' }}
                  alt="reference"
                  draggable={false}
                />

                {cropBox && (
                  <>
                    {/* Dark overlay — 4 panels outside the crop box */}
                    <div className="crop-overlay-panel" style={{ left: 0, top: 0, right: 0, height: cropBox.y }} />
                    <div className="crop-overlay-panel" style={{ left: 0, top: cropBox.y + cropBox.h, right: 0, bottom: 0 }} />
                    <div className="crop-overlay-panel" style={{ left: 0, top: cropBox.y, width: cropBox.x, height: cropBox.h }} />
                    <div className="crop-overlay-panel" style={{ left: cropBox.x + cropBox.w, top: cropBox.y, right: 0, height: cropBox.h }} />

                    {/* Crop border */}
                    <div className="crop-border" style={{
                      left: cropBox.x, top: cropBox.y,
                      width: cropBox.w, height: cropBox.h,
                    }}>
                      {/* Rule-of-thirds grid — visible while dragging */}
                      {isDragging && (
                        <>
                          <div className="grid-line" style={{ left: '33.33%', top: 0, bottom: 0, width: 1 }} />
                          <div className="grid-line" style={{ left: '66.66%', top: 0, bottom: 0, width: 1 }} />
                          <div className="grid-line" style={{ top: '33.33%', left: 0, right: 0, height: 1 }} />
                          <div className="grid-line" style={{ top: '66.66%', left: 0, right: 0, height: 1 }} />
                        </>
                      )}
                    </div>

                    {/* Resize handles */}
                    {handles.map((h) => (
                      <div
                        key={h.name}
                        className="crop-handle"
                        style={{
                          left: h.px - HANDLE_SIZE / 2,
                          top: h.py - HANDLE_SIZE / 2,
                          width: HANDLE_SIZE,
                          height: HANDLE_SIZE,
                        }}
                      />
                    ))}

                  </>
                )}
              </div>

              {/* Crop controls */}
              {rawImageSize && (
                <div className="crop-actions">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleAlignFace}
                    disabled={aligningFace}
                  >
                    {aligningFace ? 'Aligning…' : '↻ Align Face'}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleCenterFace}
                    disabled={centeringFace}
                  >
                    {centeringFace ? 'Detecting…' : '⊙ Center Face'}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleReset}
                  >
                    Reset
                  </button>
                </div>
              )}
              <div className="hint-text">Drag handles to resize · drag inside to reposition</div>
            </div>
          )}

          {/* Aspect ratio */}
          <div className="m-b-16">
            <label className="input-label">Output Aspect Ratio</label>
            <div className="ar-buttons">
              {ASPECT_RATIOS.map((ar) => (
                <button
                  key={ar}
                  className={`btn-ar ${aspectRatio === ar ? 'active' : ''}`}
                  onClick={() => setAspectRatio(ar)}
                >
                  {ar}
                </button>
              ))}
            </div>
          </div>

          {loading && (
            <div className="hint-text">Detecting face…</div>
          )}


        </div>
      </div>

      <div className="split-divider" />

      {/* ── Right panel: source folder + start ── */}
      <div className="split-panel">
        <div className="setup-section">
          <div className="subtitle">Source Folder</div>
          <button
            className="btn btn-secondary m-b-12"
            onClick={handleChooseFolder}
          >
            Choose Folder
          </button>
          {sourceFolderPath && <div className="path-display">{sourceFolderPath}</div>}
        </div>

        <div className="setup-section">
          <div className="subtitle">Ready to Scan</div>
          {!referenceEmbedding && (
            <div className="hint-text m-b-12">Set a reference photo first.</div>
          )}
          {!sourceFolderPath && (
            <div className="hint-text m-b-12">Choose a source folder.</div>
          )}
          <button
            className="btn start-btn"
            onClick={handleStartScan}
            disabled={!canStartScan}
          >
            Start Scan
          </button>
        </div>
      </div>

    </div>
  )
}
