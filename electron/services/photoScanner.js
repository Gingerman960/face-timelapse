'use strict'

const fs = require('fs')
const path = require('path')
const { detectFaceFromBuffer } = require('./faceDetection')
const { generateEmbedding, compareFaces, categorize } = require('./faceEmbedding')

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.tiff', '.tif', '.webp'])

/**
 * Scan a folder for photos matching the reference face.
 * Port of PhotoScannerService.swift adapted for filesystem folders.
 *
 * @param {string} folderPath - Folder to scan
 * @param {number[]} referenceEmbedding - 45-feature embedding of reference face
 * @param {{ cancelled: boolean }} cancelToken - Shared cancel flag
 * @param {Function} onProgress - Called with progress object per photo
 * @returns {Promise<PhotoCandidate[]>}
 */
async function scanFolder(folderPath, referenceEmbedding, modelsPath, cancelToken, onProgress) {
  const sharp = require('sharp')
  const exifr = require('exifr')

  // Collect all supported image files
  const allFiles = listImageFiles(folderPath)
  const total = allFiles.length

  if (total === 0) return []

  const candidates = []

  const { Worker } = require('worker_threads')
  const os = require('os')

  return new Promise((resolve) => {
    let currentIndex = 0
    let completed = 0
    let confirmedCount = 0
    let uncertainCount = 0

    const numCpus = Math.max(1, os.cpus().length - 1)
    const maxWorkers = Math.min(numCpus, allFiles.length)
    const workers = []

    const assignTask = (worker) => {
      if (cancelToken.cancelled || currentIndex >= allFiles.length) return false

      const idx = currentIndex++
      const filePath = allFiles[idx]
      worker.postMessage({
        filePath,
        filename: path.basename(filePath),
        referenceEmbedding,
        index: idx
      })
      return true
    }

    const checkComplete = () => {
      if (cancelToken.cancelled || completed === allFiles.length) {
        workers.forEach(w => w.terminate())
        candidates.sort((a, b) => b.similarityScore - a.similarityScore)
        resolve(candidates)
      }
    }

    const startWorker = () => {
      const worker = new Worker(path.join(__dirname, 'scanWorker.js'), {
        workerData: { modelsPath }
      })

      worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          assignTask(worker)
        } else if (msg.type === 'result') {
          candidates.push(msg.result)
          if (msg.result.status === 'confirmed') confirmedCount++
          if (msg.result.status === 'uncertain') uncertainCount++

          onProgress({
            index: msg.index,
            total,
            filename: msg.result.filename,
            thumbnailBase64: msg.thumbnailBase64,
            status: 'scanning',
            confirmed: confirmedCount,
            uncertain: uncertainCount,
          })

          completed++
          if (!assignTask(worker)) checkComplete()
        } else if (msg.type === 'skipped') {
          onProgress({
            index: msg.index,
            total,
            filename: msg.filename,
            thumbnailBase64: msg.thumbnailBase64,
            status: 'scanning',
            confirmed: confirmedCount,
            uncertain: uncertainCount,
          })

          completed++
          if (!assignTask(worker)) checkComplete()
        } else if (msg.type === 'error') {
          console.error(`Scan worker error:`, msg.error)
        }
      })

      worker.on('error', (err) => {
        // A worker crash forfeits the in-flight task. We still advance `completed`
        // so the scan can terminate rather than hanging on a lost slot.
        console.error(`Scan worker crashed:`, err)
        completed++
        checkComplete()
      })

      workers.push(worker)
    }

    // Start initial workers
    for (let i = 0; i < maxWorkers; i++) {
      startWorker()
    }
  })
}

/**
 * Recursively list all supported image files in a directory.
 */
function listImageFiles(dir) {
  const results = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...listImageFiles(fullPath))
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          results.push(fullPath)
        }
      }
    }
  } catch (_) { }
  return results
}

module.exports = { scanFolder, listImageFiles }
