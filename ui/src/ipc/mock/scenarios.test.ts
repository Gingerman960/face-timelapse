import { describe, expect, it } from 'vitest'
import type { LibraryCounts, SessionSnapshot } from '../contract'
import { FakeBackend } from './fakeBackend'
import { DEMO_FOLDER, REFERENCE_PATH, RESTORED_CROP } from './fixtures'
import { MOCK_SCENARIOS, type MockScenario } from './options'

async function snapshot(scenario: MockScenario): Promise<SessionSnapshot> {
  return new FakeBackend({ scenario, speed: 'instant' }).call('get_session', {})
}

const EXPECTED_COUNTS: Record<MockScenario, Partial<LibraryCounts>> = {
  fresh: { total: 0, included: 0, days: 0, activeDays: 0, reviewPending: 0 },
  ready: { total: 0, included: 0, days: 0, activeDays: 0, reviewPending: 0 },
  scanned: { total: 3593, confirmed: 3529, uncertain: 41, rejected: 6, noFace: 17, failed: 0, reviewPending: 41, included: 3529, days: 3518, activeDays: 3518 },
  reviewed: { total: 3593, uncertain: 41, reviewPending: 0, included: 3558, days: 3547, activeDays: 3547 },
  aligned: { total: 3593, uncertain: 41, reviewPending: 0, included: 3558, days: 3547, activeDays: 3547 },
}

describe('scenarios', () => {
  it.each(MOCK_SCENARIOS)('%s has consistent counts', async (scenario) => {
    const s = await snapshot(scenario)
    const c = s.counts
    expect(c).toMatchObject(EXPECTED_COUNTS[scenario])
    expect(c.confirmed + c.uncertain + c.rejected + c.noFace + c.failed).toBe(c.total)
    expect(c.activeDays).toBeLessThanOrEqual(c.days)
    expect(c.days).toBeLessThanOrEqual(c.included)
    expect(s.frames.expected).toBe(c.activeDays)
    expect(s.activeJob).toBeNull()
  })

  it('fresh is a first run (setup only)', async () => {
    const s = await snapshot('fresh')
    expect(s).toMatchObject({ reference: null, folder: null, scan: { status: 'none' }, frames: { status: 'none', count: 0 } })
  })

  it('ready has the restored 3:4 crop, the folder, 412 cached files and no scan', async () => {
    const s = await snapshot('ready')
    expect(s.reference).toMatchObject({ aspect: '3:4', crop: RESTORED_CROP, image: { path: REFERENCE_PATH } })
    expect(s.reference?.detection?.anchors).toHaveLength(5)
    expect(s.folder).toEqual({ path: DEMO_FOLDER, name: 'Daily selfies', imageCount: 3593, analyzedCount: 412, unsupportedCount: 2 })
    expect(s.scan.status).toBe('none')
    expect(s.frames.outputSize).toEqual({ width: 1080, height: 1440 })
    expect(s.recents).toEqual({ references: [REFERENCE_PATH], folders: [DEMO_FOLDER] })
  })

  it('scanned is complete with 41 photos to review (review reachable)', async () => {
    const s = await snapshot('scanned')
    expect(s.scan.status).toBe('complete')
    expect(s.scan.lastSummary).toMatchObject({ total: 3593, confirmed: 3529, uncertain: 41, durationMs: 92_128 })
    expect(s.scan.scannedAt).toBe('2026-10-23T21:14:05')
    expect(s.frames.status).toBe('none')
  })

  it('reviewed has days ready and no frames', async () => {
    const s = await snapshot('reviewed')
    expect(s.frames).toEqual({ status: 'none', count: 0, expected: 3547, outputSize: { width: 1080, height: 1440 } })
  })

  it('aligned is the restored session: frames complete, look off, 30 fps video', async () => {
    const s = await snapshot('aligned')
    expect(s.frames).toEqual({ status: 'complete', count: 3547, expected: 3547, outputSize: { width: 1080, height: 1440 } })
    expect(s.look.normalize).toBe('off')
    expect(s.video).toMatchObject({ pace: { mode: 'fps', fps: 30 }, resolution: 'source', quality: 'high', holdLastSecs: 1 })
  })

  it('is deterministic across instances', async () => {
    const a = await new FakeBackend({ scenario: 'aligned', speed: 'instant' }).call('get_frames', {})
    const b = await new FakeBackend({ scenario: 'aligned', speed: 'instant' }).call('get_frames', {})
    expect(a).toEqual(b)
  })
})
