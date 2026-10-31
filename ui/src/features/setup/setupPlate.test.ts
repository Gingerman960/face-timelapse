// Critique round 4, P2-11: after a scan, "Scan library ⌘↩" stayed the only plate on
// Reference even with nothing left to read; the plate is now the next step.
import { describe, expect, it } from 'vitest'
import { makeSession } from '../../test/session'
import { setupPlate } from './setupModel'

describe('the Reference plate', () => {
  it('scans before the first scan, and resumes a stopped one', () => {
    expect(setupPlate(makeSession('ready'))).toEqual({ action: 'scan', label: 'Scan library' })
    const stopped = makeSession('ready')
    expect(setupPlate({ ...stopped, scan: { ...stopped.scan, status: 'partial' } })).toEqual({ action: 'scan', label: 'Resume scan' })
  })

  it('after a scan: the new photos waiting, else the unsure ones, else Days', () => {
    const scanned = makeSession('scanned')
    const folder = scanned.folder!
    const waiting = { ...scanned, folder: { ...folder, analyzedCount: folder.imageCount - 12 } }
    expect(setupPlate(waiting)).toEqual({ action: 'scan', label: 'Scan 12 new photos' })
    const one = { ...waiting, folder: { ...folder, analyzedCount: folder.imageCount - 1 } }
    expect(setupPlate(one).label).toBe('Scan 1 new photo')

    const read = { ...scanned, folder: { ...folder, analyzedCount: folder.imageCount } }
    expect(setupPlate({ ...read, counts: { ...read.counts, reviewPending: 1 } })).toEqual({ action: 'review', label: 'Review 1 unsure' })
    expect(setupPlate({ ...read, counts: { ...read.counts, reviewPending: 0 } })).toEqual({ action: 'days', label: 'Open Days' })
  })
})
