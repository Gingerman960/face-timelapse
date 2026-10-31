// QA 31: the plate counted every active day ("Re-align 3,580 days") when one was missing.
import { describe, expect, it } from 'vitest'
import type { FramesInfo } from '../../ipc/contract'
import { ALIGN_AGAIN, alignPlateLabel, daysToAlign } from './alignPlate'

const frames = (status: FramesInfo['status'], count: number, expected: number): FramesInfo => ({ status, count, expected, outputSize: null })

describe('alignPlateLabel', () => {
  it('aligns every active day the first time', () => {
    expect(alignPlateLabel(frames('none', 0, 3547), 3547)).toBe('Align 3,547 days')
    expect(alignPlateLabel(frames('none', 0, 1), 1)).toBe('Align 1 day')
  })

  it('counts only the missing days when some frames are current', () => {
    expect(alignPlateLabel(frames('partial', 3579, 3580), 3580)).toBe('Re-align 1 day')
    expect(alignPlateLabel(frames('partial', 3577, 3580), 3580)).toBe('Re-align 3 days')
  })

  it('re-aligns every day when all frames are stale', () => {
    expect(alignPlateLabel(frames('stale', 0, 3580), 3580)).toBe('Re-align 3,580 days')
  })

  it('says "Align again" without a count when the info cannot tell', () => {
    expect(alignPlateLabel(frames('partial', 12, 12), 12)).toBe(ALIGN_AGAIN)
    expect(daysToAlign(frames('complete', 12, 12), 12)).toBeNull()
  })
})
