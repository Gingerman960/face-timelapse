// Critique round 6, P1-4: a run of days (⇧-click, ⇧←/⇧→) that X leaves out or puts back at once.
import { describe, expect, it } from 'vitest'
import type { DayGroup } from '../../ipc/contract'
import { inRun, runChanges, runCount, runLabel, runMessage, runOf } from './dayRun'

const group = (dayKey: string, excluded = false): DayGroup => ({ dayKey, photoIds: ['a'], selectedId: 'a', autoSelectedId: 'a', manualSelection: false, excluded })
const byDay = (...groups: DayGroup[]) => new Map(groups.map((g) => [g.dayKey, g]))

describe('runOf', () => {
  it('is no run without an anchor, or when the anchor is the day itself', () => {
    expect(runOf(null, '2014-05-02')).toBeNull()
    expect(runOf('2014-05-02', '2014-05-02')).toBeNull()
  })

  it('spans the anchor and the day in date order, whichever way it was drawn', () => {
    expect(runOf('2014-05-05', '2014-05-02')).toEqual({ start: '2014-05-02', end: '2014-05-05' })
    expect(runOf('2014-05-02', '2014-05-05')).toEqual({ start: '2014-05-02', end: '2014-05-05' })
  })
})

describe('inRun and runCount', () => {
  it('holds both ends and counts calendar days, empty ones included', () => {
    const run = { start: '2014-04-29', end: '2014-05-02' }
    expect(inRun(run, '2014-04-29')).toBe(true)
    expect(inRun(run, '2014-05-02')).toBe(true)
    expect(inRun(run, '2014-05-03')).toBe(false)
    expect(inRun(null, '2014-05-02')).toBe(false)
    expect(runCount(run)).toBe(4)
  })
})

describe('runChanges', () => {
  const run = { start: '2014-05-01', end: '2014-05-04' }

  it('leaves out every day with a photo while any is still in, and skips empty days', () => {
    // Arrange: 3 May has no photo; 2 May is already out.
    const days = byDay(group('2014-05-01'), group('2014-05-02', true), group('2014-05-04'))

    // Act
    const plan = runChanges(run, days)

    // Assert
    expect(plan.excluded).toBe(true)
    expect(plan.changes).toEqual([
      { dayKey: '2014-05-01', excluded: true },
      { dayKey: '2014-05-04', excluded: true },
    ])
  })

  it('puts every day back once all of them are out', () => {
    const plan = runChanges(run, byDay(group('2014-05-01', true), group('2014-05-04', true)))
    expect(plan.excluded).toBe(false)
    expect(plan.changes.map((c) => c.excluded)).toEqual([false, false])
  })

  it('has nothing to change in a run of empty days', () => {
    expect(runChanges(run, byDay()).changes).toEqual([])
  })
})

describe('labels', () => {
  it('names the run by its dates, shortest within one month', () => {
    expect(runLabel({ start: '2014-05-02', end: '2014-05-05' })).toBe('2–5 May 2014')
    expect(runLabel({ start: '2014-04-29', end: '2014-05-02' })).toBe('29 Apr – 2 May 2014')
    expect(runLabel({ start: '2013-12-30', end: '2014-01-02' })).toBe('30 Dec 2013 – 2 Jan 2014')
  })

  it('says what X did, in days', () => {
    expect(runMessage(true, 1)).toBe('Left 1 day out')
    expect(runMessage(true, 3547)).toBe('Left 3,547 days out')
    expect(runMessage(false, 2)).toBe('Put 2 days back in')
  })
})
