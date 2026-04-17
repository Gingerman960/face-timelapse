import { describe, it, expect, beforeAll } from 'vitest'
import { integrationStatus, loadAsJpegBuffer } from './helpers.js'

const status = integrationStatus()

describe.skipIf(!status.run)(`face detection integration (${status.images.length} photos)`, () => {
  let initFaceDetection, detectFaceFromBuffer

  beforeAll(async () => {
    // Load lazily — if the env gate is closed, these modules may require
    // native bindings we don't want to pull in for the regular unit-test run.
    ;({ initFaceDetection, detectFaceFromBuffer } = await import('../../electron/services/faceDetection.js'))
    await initFaceDetection(status.modelsPath)
  }, 30_000)

  it('detects 68 landmarks in the first sample photo', async () => {
    const buf = await loadAsJpegBuffer(status.images[0])
    const result = await detectFaceFromBuffer(buf)
    expect(result).not.toBeNull()
    expect(result.landmarks68).toHaveLength(68)
    expect(result.alignmentPoints).toHaveLength(5)
    for (const pt of result.alignmentPoints) {
      expect(Number.isFinite(pt.x)).toBe(true)
      expect(Number.isFinite(pt.y)).toBe(true)
    }
  }, 30_000)

  it('returns consistent landmarks on repeated detection of the same image', async () => {
    const buf = await loadAsJpegBuffer(status.images[0])
    const a = await detectFaceFromBuffer(buf)
    const b = await detectFaceFromBuffer(buf)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    // Detection is deterministic for a fixed input buffer
    for (let i = 0; i < 68; i++) {
      expect(b.landmarks68[i].x).toBeCloseTo(a.landmarks68[i].x, 3)
      expect(b.landmarks68[i].y).toBeCloseTo(a.landmarks68[i].y, 3)
    }
  }, 30_000)
})

if (!status.run) {
  // Tell the runner why we skipped so the user sees it in CI logs / local output.
  describe(`integration tests skipped: ${status.skipReason}`, () => {
    it.skip('skipped', () => {})
  })
}
