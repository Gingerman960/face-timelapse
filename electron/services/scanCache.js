'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const CACHE_VERSION = 1
const DEFAULT_MAX_AGE_DAYS = 30

/**
 * Deterministic cache key for a (folderPath, referenceEmbedding) pair.
 * Same folder + same reference photo → same cache file. A different
 * reference invalidates automatically because its hash changes.
 */
function cacheKey(folderPath, referenceEmbedding) {
  const hash = crypto.createHash('sha256')
  hash.update(String(folderPath))
  hash.update(JSON.stringify(referenceEmbedding ?? null))
  return hash.digest('hex').slice(0, 16)
}

function cacheFilePath(cacheDir, key) {
  return path.join(cacheDir, `${key}.json`)
}

/**
 * Load a cache file. Returns { key, entries } where entries is a Map
 * keyed by absolute filePath. On error (missing, corrupted, wrong
 * version) returns an empty Map — the scan just falls back to full work.
 */
function load(cacheDir, folderPath, referenceEmbedding) {
  const key = cacheKey(folderPath, referenceEmbedding)
  const empty = { key, entries: new Map(), createdAt: null }
  if (!cacheDir) return empty

  const file = cacheFilePath(cacheDir, key)
  if (!fs.existsSync(file)) return empty

  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.version !== CACHE_VERSION) return empty
    const entries = new Map(Object.entries(data.entries || {}))
    return { key, entries, createdAt: data.createdAt || null }
  } catch (err) {
    // Corrupted caches are a nuisance, not a bug. Log once and move on.
    console.warn('scanCache: failed to load, ignoring:', err.message)
    return empty
  }
}

/**
 * Write cache to disk. Accepts a Map (or plain object) of entries.
 * Safe to call with cacheDir=null (no-op).
 */
function save(cacheDir, { key, folderPath, referenceEmbedding, entries, createdAt }) {
  if (!cacheDir) return
  fs.mkdirSync(cacheDir, { recursive: true })

  const entriesObj = entries instanceof Map ? Object.fromEntries(entries) : entries

  const payload = {
    version: CACHE_VERSION,
    folderPath,
    referenceEmbeddingHash: cacheKey(folderPath, referenceEmbedding),
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries: entriesObj,
  }

  const file = cacheFilePath(cacheDir, key)
  // Write to a temp file then rename for atomicity — interrupting a big
  // write mid-flight would otherwise leave us with half a JSON file.
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(payload))
  fs.renameSync(tmp, file)
}

/**
 * Delete cache files older than maxAgeDays (default 30). Called at app
 * startup so stale caches don't accumulate forever.
 */
function pruneOld(cacheDir, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  if (!cacheDir || !fs.existsSync(cacheDir)) return 0
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  let removed = 0
  for (const name of fs.readdirSync(cacheDir)) {
    if (!name.endsWith('.json')) continue
    const file = path.join(cacheDir, name)
    try {
      const stats = fs.statSync(file)
      if (stats.mtimeMs < cutoff) {
        fs.unlinkSync(file)
        removed++
      }
    } catch (_) {}
  }
  return removed
}

/**
 * Check whether a cache entry is still valid for a given filePath by
 * comparing the recorded mtime against the file's current mtime. Returns
 * the cached result if valid, otherwise null.
 */
function validateEntry(filePath, entry) {
  if (!entry || typeof entry.mtimeMs !== 'number') return null
  try {
    const stats = fs.statSync(filePath)
    if (stats.mtimeMs !== entry.mtimeMs) return null
    return entry.result || null
  } catch (_) {
    return null
  }
}

module.exports = {
  cacheKey,
  cacheFilePath,
  load,
  save,
  pruneOld,
  validateEntry,
  CACHE_VERSION,
  DEFAULT_MAX_AGE_DAYS,
}
