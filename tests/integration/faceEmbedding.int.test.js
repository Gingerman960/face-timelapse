import { describe, it, expect, beforeAll } from 'vitest'
import { integrationStatus, loadAsJpegBuffer } from './helpers.js'
import { generateEmbedding, compareFaces, categorize, THRESHOLDS } from '../../electron/services/faceEmbedding.js'

const status = integrationStatus()

// Pipeline tests need at least 2 photos of the same person.
const enoughPhotos = status.run && status.images.length >= 2

describe.skipIf(!enoughPhotos)(`face embedding pipeline (${status.images.length} photos)`, () => {
  let initFaceDetection, detectFaceFromBuffer

  beforeAll(async () => {
    ;({ initFaceDetection, detectFaceFromBuffer } = await import('../../electron/services/faceDetection.js'))
    await initFaceDetection(status.modelsPath)
  }, 30_000)

  it('embedding of the same detection compares to itself at ~1.0', async () => {
    const buf = await loadAsJpegBuffer(status.images[0])
    const detection = await detectFaceFromBuffer(buf)
    expect(detection).not.toBeNull()
    const emb = generateEmbedding(detection.landmarks68)
    expect(emb).toHaveLength(45)
    expect(compareFaces(emb, emb)).toBeCloseTo(1, 6)
  }, 30_000)

  it('two photos of the same person score above rejected and ideally confirmed', async () => {
    const [a, b] = status.images
    const [bufA, bufB] = await Promise.all([loadAsJpegBuffer(a), loadAsJpegBuffer(b)])
    const [detA, detB] = await Promise.all([detectFaceFromBuffer(bufA), detectFaceFromBuffer(bufB)])
    expect(detA).not.toBeNull()
    expect(detB).not.toBeNull()

    const embA = generateEmbedding(detA.landmarks68)
    const embB = generateEmbedding(detB.landmarks68)
    const score = compareFaces(embA, embB)
    const status_ = categorize(score)

    // Same person across photos should never score as rejected.
    // We allow `uncertain` because angle/lighting variation in real photos
    // can push legitimate matches below the confirmed threshold.
    expect(status_).not.toBe('rejected')
    expect(score).toBeGreaterThan(THRESHOLDS.uncertain)
  }, 60_000)
})

if (!status.run) {
  describe(`integration tests skipped: ${status.skipReason}`, () => {
    it.skip('skipped', () => {})
  })
} else if (!enoughPhotos) {
  describe('face embedding pipeline skipped: need at least 2 photos', () => {
    it.skip('skipped', () => {})
  })
}
