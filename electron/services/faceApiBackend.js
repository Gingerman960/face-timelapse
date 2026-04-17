'use strict'

/**
 * Pick the fastest available face-api.js backend for this platform.
 *
 * Priority (first successful wins):
 *   1. FACE_API_BACKEND env var override — 'gpu' | 'node' | 'wasm'
 *   2. @tensorflow/tfjs-node-gpu (CUDA) — Linux/Windows with NVIDIA hardware
 *   3. @tensorflow/tfjs-node (native CPU) — faster than WASM, universal
 *   4. WASM + SIMD — always available, cross-platform fallback
 *
 * Neither `@tensorflow/tfjs-node-gpu` nor `@tensorflow/tfjs-node` are in
 * package.json; users install them manually if they want faster inference.
 * See docs/BUILD.md for the install steps.
 */

const AVAILABLE_BACKENDS = ['gpu', 'node', 'wasm']

function buildAttempts(override) {
  if (override === 'wasm') {
    return [{ name: 'wasm', apiPath: 'face-api.node-wasm', tfPkg: null }]
  }

  const attempts = []
  if (!override || override === 'gpu') {
    attempts.push({ name: 'gpu', apiPath: 'face-api.node-gpu', tfPkg: '@tensorflow/tfjs-node-gpu' })
  }
  if (!override || override === 'node') {
    attempts.push({ name: 'node', apiPath: 'face-api.node', tfPkg: '@tensorflow/tfjs-node' })
  }
  // WASM is always the final fallback unless the override rules it out above.
  attempts.push({ name: 'wasm', apiPath: 'face-api.node-wasm', tfPkg: null })
  return attempts
}

function loadFaceApiBackend({ logger = console } = {}) {
  const override = process.env.FACE_API_BACKEND
  if (override && !AVAILABLE_BACKENDS.includes(override)) {
    logger.warn(`FACE_API_BACKEND=${override} is not one of ${AVAILABLE_BACKENDS.join(', ')} — ignoring`)
  }

  const attempts = buildAttempts(override)

  for (const attempt of attempts) {
    try {
      if (attempt.tfPkg) {
        // Confirm the native tfjs package resolves & loads before we commit
        // to the matching face-api entrypoint. A missing native binding
        // throws here instead of corrupting later detection calls.
        require(attempt.tfPkg)
      }
      const faceapi = require(`@vladmandic/face-api/dist/${attempt.apiPath}`)
      logger.log(`face-api backend: ${attempt.name}`)
      return { backend: attempt.name, faceapi }
    } catch (err) {
      if (process.env.FACE_TIMELAPSE_DEBUG) {
        logger.warn(`face-api backend '${attempt.name}' unavailable:`, err.message)
      }
    }
  }

  throw new Error('No face-api backend could be loaded')
}

module.exports = {
  loadFaceApiBackend,
  buildAttempts,        // exported for tests
  AVAILABLE_BACKENDS,
}
