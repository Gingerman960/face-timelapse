'use strict'

const fs = require('fs')
const path = require('path')

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp'])

/**
 * Reason strings returned by `integrationStatus()` to indicate why the
 * integration tests skipped — surfaced in the test output so the user can
 * act on the missing prerequisite.
 */
const SKIP_ENV_MISSING = 'FACETIMELAPSE_INTEGRATION_PHOTOS is not set'
const SKIP_ENV_EMPTY = 'integration photo directory contains no supported images'
const SKIP_MODELS_MISSING = 'models/ directory missing — run `npm run download-models`'
const SKIP_CANVAS_ABI = '@napi-rs/canvas failed to load — run `npm install` to fetch prebuilt binaries'

/**
 * Decide whether integration tests should run, and if not, why.
 * Called from test files to produce a `describe.skipIf(...)` gate with a
 * clear skip reason.
 *
 * @returns {{ run: boolean, skipReason: string|null, photosDir: string|null, modelsPath: string|null, images: string[] }}
 */
function integrationStatus() {
  const photosDir = process.env.FACETIMELAPSE_INTEGRATION_PHOTOS
  if (!photosDir) {
    return { run: false, skipReason: SKIP_ENV_MISSING, photosDir: null, modelsPath: null, images: [] }
  }

  const modelsPath = path.resolve(__dirname, '../../models')
  const manifest = path.join(modelsPath, 'face_landmark_68_model-weights_manifest.json')
  if (!fs.existsSync(manifest)) {
    return { run: false, skipReason: SKIP_MODELS_MISSING, photosDir, modelsPath, images: [] }
  }

  let images = []
  try {
    images = fs.readdirSync(photosDir)
      .filter((name) => SUPPORTED.has(path.extname(name).toLowerCase()))
      .map((name) => path.join(photosDir, name))
  } catch (_) {
    return { run: false, skipReason: SKIP_ENV_EMPTY, photosDir, modelsPath, images: [] }
  }

  if (images.length === 0) {
    return { run: false, skipReason: SKIP_ENV_EMPTY, photosDir, modelsPath, images: [] }
  }

  // Try loading the canvas binding now — defer the failure into skip rather than
  // letting it blow up inside beforeAll with a cryptic load error.
  try {
    require('@napi-rs/canvas')
  } catch (err) {
    return { run: false, skipReason: `${SKIP_CANVAS_ABI} (${err.code || err.message})`, photosDir, modelsPath, images }
  }

  return { run: true, skipReason: null, photosDir, modelsPath, images }
}

/**
 * Load an image file into a JPEG buffer via sharp (auto-oriented).
 * Pair with face-api's detectFaceFromBuffer.
 */
async function loadAsJpegBuffer(imagePath, maxSide = 800) {
  const sharp = require('sharp')
  return sharp(imagePath)
    .rotate()
    .resize(maxSide, maxSide, { fit: 'inside' })
    .jpeg({ quality: 88 })
    .toBuffer()
}

module.exports = {
  integrationStatus,
  loadAsJpegBuffer,
  SKIP_ENV_MISSING,
  SKIP_ENV_EMPTY,
  SKIP_MODELS_MISSING,
  SKIP_CANVAS_ABI,
}
