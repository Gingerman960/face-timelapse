'use strict'

const fs = require('fs')
const path = require('path')
const scanCache = require('./scanCache')

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.tiff', '.tif', '.webp'])

// Match the alignment worker watchdog so a misconfigured install can't hang
// the scan step forever.
const WORKER_READY_TIMEOUT_MS = 30_000

// How many new-entry writes to accumulate before flushing the cache file.
// Lower = safer on crash, higher = less I/O. 25 is a fine balance for
// thousand-photo scans on spinning disks.
const CACHE_FLUSH_INTERVAL = 25

/**
 * Scan a folder for photos matching the reference face.
 *
 * Supports resumable scans via an optional cacheDir: the second run against
 * the same folder + same reference photo will skip files whose mtime hasn't
 * changed since the last scan, preserving their embedding / similarity /
 * creationDate from cache.
 *
 * @param {string} folderPath
 * @param {number[]} referenceEmbedding
 * @param {string} modelsPath
 * @param {{ cancelled: boolean }} cancelToken
 * @param {Function} onProgress  called with { index, total, filename, thumbnailBase64, status, confirmed, uncertain, cached }
 * @param {string|null} cacheDir  directory to persist JSON cache files (null disables caching)
 */
async function scanFolder(folderPath, referenceEmbedding, modelsPath, cancelToken, onProgress, cacheDir = null) {
  // Collect all supported image files
  const allFiles = listImageFiles(folderPath)
  const total = allFiles.length

  if (total === 0) return []

  // Load existing cache and partition files into cache-hits and to-scan.
  const { key: cacheKey, entries: cachedMap, createdAt: cacheCreatedAt } =
    scanCache.load(cacheDir, folderPath, referenceEmbedding)

  const candidates = []
  const toScan = []
  let confirmedCount = 0
  let uncertainCount = 0
  let cachedHits = 0
  let progressIndex = 0

  for (const filePath of allFiles) {
    const entry = cachedMap.get(filePath)
    const validatedResult = scanCache.validateEntry(filePath, entry)

    if (validatedResult) {
      candidates.push(validatedResult)
      if (validatedResult.status === 'confirmed') confirmedCount++
      if (validatedResult.status === 'uncertain') uncertainCount++
      cachedHits++

      // Emit a lightweight progress event for each cache hit so the UI
      // shows the fast-skip count advancing.
      onProgress({
        index: progressIndex++,
        total,
        filename: validatedResult.filename,
        thumbnailBase64: null,
        status: 'scanning',
        cached: true,
        cachedHits,
        confirmed: confirmedCount,
        uncertain: uncertainCount,
      })
    } else {
      toScan.push(filePath)
    }
  }

  // Everything was cached — short-circuit the worker pool.
  if (toScan.length === 0 || cancelToken.cancelled) {
    candidates.sort((a, b) => b.similarityScore - a.similarityScore)
    return candidates
  }

  const { Worker } = require('worker_threads')
  const os = require('os')

  return new Promise((resolve, reject) => {
    let currentIndex = 0
    let completed = 0
    let writesSinceFlush = 0
    let settled = false

    const numCpus = Math.max(1, os.cpus().length - 1)
    const maxWorkers = Math.min(numCpus, toScan.length)
    const workers = []
    const readyTimeouts = new Map()

    // Mutable cache entries — we update this as results come in and
    // flush to disk periodically.
    const cacheEntries = new Map(cachedMap)

    const flushCache = () => {
      if (!cacheDir) return
      scanCache.save(cacheDir, {
        key: cacheKey,
        folderPath,
        referenceEmbedding,
        entries: cacheEntries,
        createdAt: cacheCreatedAt,
      })
      writesSinceFlush = 0
    }

    const finish = (reason, err) => {
      if (settled) return
      settled = true
      for (const t of readyTimeouts.values()) clearTimeout(t)
      workers.forEach((w) => { try { w.terminate() } catch (_) {} })
      flushCache()
      if (reason === 'error') return reject(err)
      candidates.sort((a, b) => b.similarityScore - a.similarityScore)
      resolve(candidates)
    }

    const assignTask = (worker) => {
      if (cancelToken.cancelled) { finish('cancelled'); return false }
      if (currentIndex >= toScan.length) return false

      const idx = currentIndex++
      const filePath = toScan[idx]
      worker.postMessage({
        filePath,
        filename: path.basename(filePath),
        referenceEmbedding,
        index: idx,
      })
      return true
    }

    const checkComplete = () => {
      if (cancelToken.cancelled || completed === toScan.length) {
        finish('done')
      }
    }

    const recordCacheEntry = (filePath, result) => {
      if (!cacheDir) return
      try {
        const stats = fs.statSync(filePath)
        cacheEntries.set(filePath, { mtimeMs: stats.mtimeMs, result })
        writesSinceFlush++
        if (writesSinceFlush >= CACHE_FLUSH_INTERVAL) flushCache()
      } catch (_) {}
    }

    const startWorker = () => {
      const worker = new Worker(path.join(__dirname, 'scanWorker.js'), {
        workerData: { modelsPath },
      })

      const readyTimer = setTimeout(() => {
        finish('error', new Error(
          `Scan worker did not initialize within ${WORKER_READY_TIMEOUT_MS / 1000}s. ` +
          `Check that models are present (run "npm run download-models").`
        ))
      }, WORKER_READY_TIMEOUT_MS)
      readyTimeouts.set(worker, readyTimer)

      worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          const t = readyTimeouts.get(worker)
          if (t) { clearTimeout(t); readyTimeouts.delete(worker) }
          assignTask(worker)
        } else if (msg.type === 'result') {
          candidates.push(msg.result)
          if (msg.result.status === 'confirmed') confirmedCount++
          if (msg.result.status === 'uncertain') uncertainCount++
          recordCacheEntry(msg.result.filePath, msg.result)

          onProgress({
            index: progressIndex++,
            total,
            filename: msg.result.filename,
            thumbnailBase64: msg.thumbnailBase64,
            status: 'scanning',
            cached: false,
            cachedHits,
            confirmed: confirmedCount,
            uncertain: uncertainCount,
          })

          completed++
          if (!assignTask(worker)) checkComplete()
        } else if (msg.type === 'skipped') {
          onProgress({
            index: progressIndex++,
            total,
            filename: msg.filename,
            thumbnailBase64: msg.thumbnailBase64,
            status: 'scanning',
            cached: false,
            cachedHits,
            confirmed: confirmedCount,
            uncertain: uncertainCount,
          })

          completed++
          if (!assignTask(worker)) checkComplete()
        } else if (msg.type === 'error') {
          console.error('Scan worker init error:', msg.error)
          finish('error', new Error(`Scan worker failed to initialize: ${msg.error}`))
        }
      })

      worker.on('error', (err) => {
        console.error('Scan worker crashed:', err)
        completed++
        checkComplete()
      })

      workers.push(worker)
    }

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
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // Accept symlinks as well as regular files — users may organize
        // photo libraries with symlinks, and the screenshot capture
        // script uses symlinks into a temp subset. Broken symlinks are
        // caught downstream when sharp() throws on read.
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
