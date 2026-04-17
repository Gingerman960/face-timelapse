'use strict'

// @napi-rs/canvas is a Rust/skia-backed canvas implementation. Prebuilt
// binaries ship for every platform we target (including Apple Silicon),
// so no electron-rebuild dance is needed, and it doesn't bundle its own
// copy of glib — which used to collide with sharp's libvips in the same
// process and caused sporadic worker crashes.
const napiCanvas = require('@napi-rs/canvas')
const { createCanvas, loadImage, Image, ImageData } = napiCanvas

// face-api occasionally does `new Canvas()` with no arguments. node-canvas
// defaulted to 300×150 (the HTML spec); @napi-rs/canvas throws because it
// can't coerce `undefined` to i32. Wrap it so defaults kick in.
class Canvas {
  constructor(width = 300, height = 150) {
    return napiCanvas.createCanvas(width | 0, height | 0)
  }
  static [Symbol.hasInstance](instance) {
    return napiCanvas.Canvas[Symbol.hasInstance](instance)
  }
}

const { loadFaceApiBackend } = require('./faceApiBackend')

// Resolved on first call to initFaceDetection(). Each worker thread and
// the main process resolve independently, so the backend choice is
// per-process and we only ever pay the require() cost once.
let faceapi = null
let modelsLoaded = false
let activeBackend = null

/**
 * Initialize face-api.js with node-canvas and load model weights from disk.
 * Must be called once at startup before any detection.
 */
async function initFaceDetection(modelsPath) {
  if (modelsLoaded) return

  if (!faceapi) {
    const resolved = loadFaceApiBackend()
    faceapi = resolved.faceapi
    activeBackend = resolved.backend
  }

  // Monkey-patch globals so face-api can use node-canvas
  faceapi.env.monkeyPatch({ Canvas, Image, ImageData })

  // Wait for the tf backend (WASM / native / GPU) to initialize.
  await faceapi.tf.ready()

  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath)
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath)

  modelsLoaded = true
}

/**
 * Returns the backend that was selected at init time, or null if init
 * hasn't run yet. Useful for diagnostics and for tests that want to
 * assert the fallback path was taken.
 */
function getActiveBackend() {
  return activeBackend
}

/**
 * Detect the largest face in an image buffer and return 68-point landmarks.
 *
 * @param {Buffer} buffer - JPEG/PNG image buffer (already oriented correctly)
 * @returns {{ landmarks68: Array<{x,y}>, alignmentPoints: Array<{x,y}>, imageSize: {w,h} } | null}
 */
async function detectFaceFromBuffer(buffer) {
  if (!modelsLoaded) throw new Error('Face detection models not loaded')

  const img = await loadImage(buffer)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)

  const detections = await faceapi
    .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
    .withFaceLandmarks()

  if (!detections || detections.length === 0) return null

  // Select largest face by bounding box area
  const largest = detections.reduce((best, d) => {
    const area = d.detection.box.width * d.detection.box.height
    const bestArea = best.detection.box.width * best.detection.box.height
    return area > bestArea ? d : best
  })

  const pts = largest.landmarks.positions // Array of {x, y}
  const landmarks68 = pts.map((p) => ({ x: p.x, y: p.y }))

  const alignmentPoints = extractAlignmentPoints(landmarks68)

  return {
    landmarks68,
    alignmentPoints,
    imageSize: { w: img.width, h: img.height },
  }
}

/**
 * Extract 5 alignment points from the 68-point landmark array.
 * Port of FaceLandmarks.swift alignment point extraction.
 *
 * face-api.js 68-point index map:
 *   faceContour:   0–16
 *   leftEyebrow:  17–21
 *   rightEyebrow: 22–26
 *   noseBridge:   27–30
 *   noseBase:     31–35
 *   leftEye:      36–41
 *   rightEye:     42–47
 *   outerLips:    48–59
 *   innerLips:    60–67
 */
function extractAlignmentPoints(landmarks68) {
  const centroid = (pts) => {
    const sum = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
    return { x: sum.x / pts.length, y: sum.y / pts.length }
  }

  const leftEye = landmarks68.slice(36, 42)
  const rightEye = landmarks68.slice(42, 48)
  const outerLips = landmarks68.slice(48, 60)

  const leftEyeCenter = centroid(leftEye)
  const rightEyeCenter = centroid(rightEye)
  const noseTip = landmarks68[30] // last point of nose bridge
  const mouthLeft = outerLips[0]  // outerLips[0] = landmarks68[48]
  const mouthRight = outerLips[6] // outerLips[6] = landmarks68[54]

  return [leftEyeCenter, rightEyeCenter, noseTip, mouthLeft, mouthRight]
}

/**
 * Read an image file and return base64-encoded JPEG (for IPC transfer to renderer).
 */
function loadImageAsBase64(filePath) {
  const fs = require('fs')
  const data = fs.readFileSync(filePath)
  return data.toString('base64')
}

module.exports = { initFaceDetection, detectFaceFromBuffer, extractAlignmentPoints, loadImageAsBase64, getActiveBackend }
