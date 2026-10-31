import { describe, expect, it } from 'vitest'
import type { JobKind, ScanStatus, SessionSnapshot } from '../ipc/contract'
import {
  LEDGER_ORDER,
  STEPS,
  isReachable,
  isStep,
  reachableSteps,
  startupStep,
  stepAfterJob,
} from './steps'

interface SessionOptions {
  scan?: ScanStatus
  uncertain?: number
  reviewPending?: number
  frames?: number
  job?: JobKind | null
}

/** Minimal session snapshot with the fields the step rules read. */
function session(o: SessionOptions = {}): SessionSnapshot {
  return {
    reference: null,
    folder: null,
    scan: { status: o.scan ?? 'none', lastSummary: null, scannedAt: null },
    counts: {
      total: 0, confirmed: 0, uncertain: o.uncertain ?? 0, rejected: 0, noFace: 0, failed: 0,
      reviewPending: o.reviewPending ?? 0, included: 0, days: 0, activeDays: 0,
    },
    render: { resolution: '1080p', backdrop: 'dimmed', refineLandmarks: false },
    look: { normalize: 'off', strength: 1 },
    frames: { status: 'none', count: o.frames ?? 0, expected: 0, outputSize: null },
    imageExport: { format: 'png', jpegQuality: 95, overwrite: false },
    video: {
      pace: { mode: 'fps', fps: 10 }, resolution: '1080p', quality: 'high',
      crossfade: { frames: 0, easing: 'easeInOut' }, caption: null, holdFirstSecs: 0, holdLastSecs: 0,
    },
    activeJob: o.job ? { jobId: 'j1', kind: o.job } : null,
    recents: { references: [], folders: [] },
  }
}

const FRESH = session()
const SCANNING = session({ job: 'scan' })
const SCANNED = session({ scan: 'complete', uncertain: 41, reviewPending: 41 })
const PARTIAL = session({ scan: 'partial' })
const ALIGNING = session({ scan: 'complete', job: 'align' })
const ALIGNED = session({ scan: 'complete', frames: 3547 })

describe('isReachable', () => {
  it('follows the §8 table with P6', () => {
    expect(reachableSteps(FRESH)).toEqual(['setup'])
    expect(reachableSteps(SCANNING)).toEqual(['setup', 'scan'])
    expect(reachableSteps(PARTIAL)).toEqual(['setup', 'scan'])
    expect(reachableSteps(SCANNED)).toEqual(['setup', 'scan', 'review', 'days'])
    expect(reachableSteps(ALIGNING)).toEqual(['setup', 'scan', 'days', 'align'])
    expect(reachableSteps(ALIGNED)).toEqual(['setup', 'scan', 'days', 'timelapse'])
  })

  it('needs uncertain photos for review and a complete scan for days', () => {
    expect(isReachable('review', session({ scan: 'partial', uncertain: 3 }))).toBe(false)
    expect(isReachable('review', session({ scan: 'complete', uncertain: 0 }))).toBe(false)
    expect(isReachable('days', PARTIAL)).toBe(false)
    expect(isReachable('timelapse', session({ frames: 1 }))).toBe(true)
  })
})

describe('startupStep', () => {
  it('restores a reachable lastStep', () => {
    expect(startupStep('days', ALIGNED)).toBe('days')
    expect(startupStep('review', SCANNED)).toBe('review')
    expect(startupStep('setup', ALIGNED)).toBe('setup')
  })

  it('restores transient steps only while their job runs', () => {
    expect(startupStep('scan', SCANNING)).toBe('scan')
    expect(startupStep('scan', ALIGNED)).toBe('timelapse')
    expect(startupStep('align', ALIGNING)).toBe('align')
    expect(startupStep('align', ALIGNED)).toBe('timelapse')
  })

  it('falls back to the furthest of timelapse → days → setup', () => {
    expect(startupStep(null, ALIGNED)).toBe('timelapse')
    expect(startupStep('review', session({ scan: 'complete' }))).toBe('days')
    expect(startupStep('timelapse', PARTIAL)).toBe('setup')
    expect(startupStep(null, FRESH)).toBe('setup')
  })
})

describe('stepAfterJob', () => {
  it('routes a finished scan to review or days', () => {
    expect(stepAfterJob('scan', 'finished', SCANNED)).toBe('review')
    expect(stepAfterJob('scan', 'finished', session({ scan: 'complete' }))).toBe('days')
    expect(stepAfterJob('scan', 'finished', PARTIAL)).toBe('scan')
    expect(stepAfterJob('scan', 'finished', session({ scan: 'partial', reviewPending: 2 }))).toBe('scan')
  })

  it('sends cancelled or failed scans to setup', () => {
    expect(stepAfterJob('scan', 'cancelled', SCANNED)).toBe('setup')
    expect(stepAfterJob('scan', 'failed', SCANNED)).toBe('setup')
  })

  it('routes align outcomes', () => {
    expect(stepAfterJob('align', 'finished', ALIGNED)).toBe('timelapse')
    expect(stepAfterJob('align', 'finished', session({ scan: 'complete' }))).toBe('days')
    expect(stepAfterJob('align', 'cancelled', ALIGNED)).toBe('days')
    expect(stepAfterJob('align', 'failed', ALIGNED)).toBe('days')
    expect(stepAfterJob('align', 'failed', FRESH)).toBe('setup')
  })

  it('stays put after exports', () => {
    expect(stepAfterJob('exportImages', 'finished', ALIGNED)).toBeNull()
    expect(stepAfterJob('exportVideo', 'failed', ALIGNED)).toBeNull()
  })
})

describe('ledger', () => {
  it('orders rows (⌘1–⌘5)', () => {
    expect(LEDGER_ORDER).toEqual(['setup', 'scan', 'review', 'days', 'timelapse'])
  })

  it('guards stored step values', () => {
    for (const step of STEPS) expect(isStep(step)).toBe(true)
    expect(isStep('results')).toBe(false)
    expect(isStep(3)).toBe(false)
    expect(isStep(null)).toBe(false)
  })
})
