import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cacheKey,
  load,
  save,
  pruneOld,
  validateEntry,
  CACHE_VERSION,
} from '../electron/services/scanCache.js'

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scanCache-test-'))
}

describe('cacheKey', () => {
  it('is stable for the same inputs', () => {
    const a = cacheKey('/photos/a', [1, 2, 3])
    const b = cacheKey('/photos/a', [1, 2, 3])
    expect(a).toBe(b)
  })

  it('changes when the folder path changes', () => {
    const a = cacheKey('/photos/a', [1, 2, 3])
    const b = cacheKey('/photos/b', [1, 2, 3])
    expect(a).not.toBe(b)
  })

  it('changes when the reference embedding changes', () => {
    const a = cacheKey('/photos/a', [1, 2, 3])
    const b = cacheKey('/photos/a', [1, 2, 4])
    expect(a).not.toBe(b)
  })

  it('handles null / undefined embedding', () => {
    expect(() => cacheKey('/photos/a', null)).not.toThrow()
    expect(() => cacheKey('/photos/a', undefined)).not.toThrow()
  })
})

describe('save → load roundtrip', () => {
  let tmpDir
  beforeEach(() => { tmpDir = makeTmpDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('persists and restores entries', () => {
    const folderPath = '/photos/a'
    const referenceEmbedding = [1, 2, 3]
    const key = cacheKey(folderPath, referenceEmbedding)
    const entries = new Map([
      ['/photos/a/1.jpg', { mtimeMs: 1000, result: { similarityScore: 0.9, status: 'confirmed' } }],
      ['/photos/a/2.jpg', { mtimeMs: 2000, result: { similarityScore: 0.5, status: 'uncertain' } }],
    ])

    save(tmpDir, { key, folderPath, referenceEmbedding, entries })

    const { entries: restored } = load(tmpDir, folderPath, referenceEmbedding)
    expect(restored.size).toBe(2)
    expect(restored.get('/photos/a/1.jpg').result.status).toBe('confirmed')
  })

  it('returns empty on missing file', () => {
    const { entries } = load(tmpDir, '/not/here', [9])
    expect(entries.size).toBe(0)
  })

  it('returns empty and logs on corrupted file', () => {
    const folderPath = '/photos/a'
    const referenceEmbedding = [1, 2, 3]
    const key = cacheKey(folderPath, referenceEmbedding)
    fs.writeFileSync(path.join(tmpDir, `${key}.json`), 'this is not json {')

    const { entries } = load(tmpDir, folderPath, referenceEmbedding)
    expect(entries.size).toBe(0)
  })

  it('returns empty when version mismatches', () => {
    const folderPath = '/photos/a'
    const referenceEmbedding = [1, 2, 3]
    const key = cacheKey(folderPath, referenceEmbedding)
    fs.writeFileSync(path.join(tmpDir, `${key}.json`), JSON.stringify({
      version: CACHE_VERSION + 99,
      entries: { '/photos/a/1.jpg': { mtimeMs: 1, result: {} } },
    }))

    const { entries } = load(tmpDir, folderPath, referenceEmbedding)
    expect(entries.size).toBe(0)
  })

  it('no-ops when cacheDir is null', () => {
    expect(() => save(null, { key: 'k', folderPath: '/x', referenceEmbedding: [], entries: new Map() })).not.toThrow()
    const { entries } = load(null, '/x', [])
    expect(entries.size).toBe(0)
  })
})

describe('pruneOld', () => {
  let tmpDir
  beforeEach(() => { tmpDir = makeTmpDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('removes files older than the cutoff', () => {
    const oldFile = path.join(tmpDir, 'old.json')
    const newFile = path.join(tmpDir, 'new.json')
    fs.writeFileSync(oldFile, '{}')
    fs.writeFileSync(newFile, '{}')

    // Age the old file by 60 days
    const sixtyDaysAgo = (Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000
    fs.utimesSync(oldFile, sixtyDaysAgo, sixtyDaysAgo)

    const removed = pruneOld(tmpDir, 30)
    expect(removed).toBe(1)
    expect(fs.existsSync(oldFile)).toBe(false)
    expect(fs.existsSync(newFile)).toBe(true)
  })

  it('ignores non-json files', () => {
    fs.writeFileSync(path.join(tmpDir, 'note.txt'), 'hello')
    const removed = pruneOld(tmpDir, 0)
    expect(removed).toBe(0)
    expect(fs.existsSync(path.join(tmpDir, 'note.txt'))).toBe(true)
  })

  it('no-ops on missing dir', () => {
    expect(pruneOld('/definitely/does/not/exist', 30)).toBe(0)
  })
})

describe('validateEntry', () => {
  let tmpDir, file
  beforeEach(() => {
    tmpDir = makeTmpDir()
    file = path.join(tmpDir, 'photo.jpg')
    fs.writeFileSync(file, 'fake jpg bytes')
  })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('returns the cached result when mtime matches', () => {
    const stats = fs.statSync(file)
    const result = validateEntry(file, { mtimeMs: stats.mtimeMs, result: { status: 'confirmed' } })
    expect(result).toEqual({ status: 'confirmed' })
  })

  it('returns null when mtime diverges', () => {
    const result = validateEntry(file, { mtimeMs: 123456789, result: { status: 'confirmed' } })
    expect(result).toBeNull()
  })

  it('returns null when file no longer exists', () => {
    const result = validateEntry('/no/such/file.jpg', { mtimeMs: 1, result: {} })
    expect(result).toBeNull()
  })

  it('returns null for malformed entries', () => {
    expect(validateEntry(file, null)).toBeNull()
    expect(validateEntry(file, {})).toBeNull()
  })
})
