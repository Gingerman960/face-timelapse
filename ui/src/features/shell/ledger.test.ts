import { describe, expect, it } from 'vitest'
import { makeReference, makeSession } from '../../test/session'
import { deriveLedger, eyesLevel, ledgerIdForStep } from './ledger'

const byId = (rows: ReturnType<typeof deriveLedger>) => Object.fromEntries(rows.map((r) => [r.id, r]))

describe('deriveLedger', () => {
  it('first run: only the reference row is open', () => {
    const rows = byId(deriveLedger(makeSession('fresh'), null))
    expect(rows.setup).toMatchObject({ status: 'ready', text: 'Not set yet', reachable: true })
    expect(rows.scan).toMatchObject({ status: 'locked', text: 'Waiting for setup', reachable: false })
    expect(rows.review?.reachable).toBe(false)
    expect(rows.days).toMatchObject({ status: 'locked', text: 'After the scan' })
    expect(rows.timelapse).toMatchObject({ status: 'locked', text: 'After the days' })
  })

  it('ready to scan shows the photo count and the reference framing', () => {
    const rows = byId(deriveLedger(makeSession('ready'), null))
    expect(rows.setup).toMatchObject({ status: 'done', text: '3:4 · eyes level' })
    expect(rows.scan).toMatchObject({ status: 'ready', text: 'Ready · 3,593 photos' })
  })

  it('a running scan shows percent, time left and a meter; review waits', () => {
    const rows = byId(deriveLedger(makeSession('ready'), { kind: 'scan', done: 2231, total: 3593, etaMs: 36_000 }))
    expect(rows.scan?.status).toBe('running')
    expect(rows.scan?.text).toBe('62% · 36 s left')
    expect(rows.scan?.progress).toBeCloseTo(0.621, 2)
    expect(rows.review).toMatchObject({ status: 'locked', text: 'After the scan' })
  })

  it('after the scan the review row asks for attention', () => {
    const rows = byId(deriveLedger(makeSession('scanned'), null))
    expect(rows.scan).toMatchObject({ status: 'done', text: '3,529 matched', reachable: true })
    expect(rows.review).toMatchObject({ status: 'attention', text: '41 of 41 left', reachable: true })
    expect(rows.days).toMatchObject({ status: 'done', reachable: true })
    expect(rows.timelapse).toMatchObject({ status: 'locked', text: 'Align from Days' })
  })

  it('a finished scan with no results (N5) reads as ready, not “0 matched”', () => {
    const s = makeSession('scanned')
    const zero = Object.fromEntries(Object.keys(s.counts).map((k) => [k, 0]))
    const rows = byId(deriveLedger({ ...s, counts: { ...s.counts, ...zero } }, null))
    expect(rows.scan).toMatchObject({ status: 'ready', text: 'Ready · 3,593 photos' })
    expect(rows.review).toMatchObject({ status: 'locked', text: 'Nothing unsure' })
  })

  it('reviewed and aligned: every row done, timelapse shows its length', () => {
    const rows = byId(deriveLedger(makeSession('aligned'), null))
    expect(rows.review).toMatchObject({ status: 'done', text: 'All 41 looked at' })
    expect(rows.days?.text).toBe('3,547 days chosen')
    expect(rows.timelapse?.status).toBe('done')
    expect(rows.timelapse?.text).toBe('1:59 · 30 days/s')
  })

  // QA N4: one pace everywhere, in days a second; the draft edited this session wins.
  it('shows the video length and the pace in days a second, as the player and export do', () => {
    const s = makeSession('aligned')
    const blend2 = { ...s.video, pace: { mode: 'fps' as const, fps: 30 }, crossfade: { frames: 2, easing: 'easeInOut' as const } }
    expect(byId(deriveLedger(s, null, { video: blend2 })).timelapse?.text).toBe('5:56 · 10 days/s')
  })

  it('stale and partial frames ask for a re-align', () => {
    const stale = makeSession('aligned', { frames: { status: 'stale', count: 3547, expected: 3547, outputSize: null } })
    expect(byId(deriveLedger(stale, null)).timelapse).toMatchObject({ status: 'attention', text: 'Re-align 3,547' })
    const partial = makeSession('aligned', { frames: { status: 'partial', count: 1204, expected: 3547, outputSize: null } })
    expect(byId(deriveLedger(partial, null)).timelapse?.text).toBe('1,204 of 3,547 aligned')
  })

  it('align and export jobs run on the timelapse row', () => {
    const align = byId(deriveLedger(makeSession('reviewed'), { kind: 'align', done: 1204, total: 3547, etaMs: null }))
    expect(align.timelapse).toMatchObject({ status: 'running', text: '34% · estimating…', step: 'align', reachable: true })
    const enc = byId(deriveLedger(makeSession('aligned'), { kind: 'exportVideo', done: 10, total: 100, etaMs: 52_000 }))
    expect(enc.timelapse?.text).toBe('Encoding · 52 s left')
    const img = byId(deriveLedger(makeSession('aligned'), { kind: 'exportImages', done: 1, total: 2, etaMs: 1000 }))
    expect(img.timelapse?.text.startsWith('Saving')).toBe(true)
  })

  it('no face in the crop, partial scans, nothing unsure, tilted eyes', () => {
    const noFace = makeSession('ready', { reference: makeReference({ detection: null }) })
    expect(byId(deriveLedger(noFace, null)).setup).toMatchObject({ status: 'attention', text: 'No face in the crop' })
    const partial = makeSession('ready', { scan: { status: 'partial', lastSummary: null, scannedAt: null } })
    expect(byId(deriveLedger(partial, null)).scan?.text).toBe('Stopped part-way · resume')
    const none = makeSession('scanned', { counts: { ...makeSession('scanned').counts, uncertain: 0, reviewPending: 0 } })
    expect(byId(deriveLedger(none, null)).review).toMatchObject({ status: 'locked', text: 'Nothing unsure' })
    const tilted = makeSession('ready', { reference: makeReference({ image: { ...makeReference().image, autoRotationDeg: 2.5 }, aspect: 'free' }) })
    expect(byId(deriveLedger(tilted, null)).setup?.text).toBe('Free crop · tilted')
  })
})

describe('eyesLevel', () => {
  it('treats tilts within 0.3° as level (ARCHITECTURE §7.3)', () => {
    expect(eyesLevel(0, -0.2)).toBe(true)
    expect(eyesLevel(0, -0.4)).toBe(false)
    expect(eyesLevel(0, 2.5)).toBe(false)
    expect(eyesLevel(2.5, 2.5)).toBe(true)
    expect(eyesLevel(0, null)).toBe(true)
  })
})

describe('ledgerIdForStep', () => {
  it('maps align onto the timelapse row', () => {
    expect(ledgerIdForStep('align')).toBe('timelapse')
    expect(ledgerIdForStep('days')).toBe('days')
  })
})

describe('timelapse row with stale frames', () => {
  it('says how many days need re-aligning (stale frames have count 0)', () => {
    const s = makeSession('aligned')
    const stale = { ...s, frames: { ...s.frames, status: 'stale' as const, count: 0, expected: 3 } }
    expect(deriveLedger(stale, null).find((r) => r.id === 'timelapse')?.text).toBe('Re-align 3')
  })
})

// QA (models missing): with no days chosen yet, a stale timelapse row read "Re-align 0".
describe('timelapse row with nothing to re-align', () => {
  it('reads like a timelapse not made yet', () => {
    const s = makeSession('ready')
    const stale = { ...s, frames: { ...s.frames, status: 'stale' as const, count: 0, expected: 0 } }
    expect(deriveLedger(stale, null).find((r) => r.id === 'timelapse')).toMatchObject({ status: 'locked' })
    expect(deriveLedger(stale, null).find((r) => r.id === 'timelapse')?.text).not.toMatch(/Re-align/)
  })
})
