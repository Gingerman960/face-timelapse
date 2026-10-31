import { describe, expect, it } from 'vitest'
import type { LibraryCounts } from '../../ipc/contract'
import { LATENT_CYCLE_MS, firstItemOnOrAfter, followTarget, latentDelay, libraryTally, liveFocusYear, liveTally, readTimeText, rovingTarget, rowMonthPrint, visibleDays } from './scanModel'

const items = ['2012-09-01', '2012-09-03', '2013-01-10', '2013-01-10', '2016-05-02', '2022-08-31'].map((dayKey, i) => ({ id: String(i), dayKey }))

// Critique round 2: the library's ribbon was pinned to the last year while the rows shown were from 2012.
describe('the library ribbon follows the sheet', () => {
  it('takes the days of the items on screen, earliest to latest', () => {
    expect(visibleDays(items, 0, 2)).toEqual({ start: '2012-09-01', end: '2013-01-10' })
    expect(visibleDays(items, 4, 99)).toEqual({ start: '2016-05-02', end: '2022-08-31' })
    expect(visibleDays([], 0, 3)).toBeNull()
  })

  it('a seek on the ribbon lands on the first photo on or after that day', () => {
    expect(firstItemOnOrAfter(items, '2013-01-01')).toBe(2)
    expect(firstItemOnOrAfter(items, '2012-09-01')).toBe(0)
    expect(firstItemOnOrAfter(items, '2023-01-01')).toBe(5)
  })
})

describe('readTimeText', () => {
  it('never says "Read in 0 s"', () => {
    expect(readTimeText(30)).toBe('Read in under a second')
    expect(readTimeText(43_300)).toBe('Read in 43 s')
  })
})

// Critique round 4, P2-15: latent frames breathed out of phase and twinkled.
describe('latentDelay: the latent run breathes as one wave', () => {
  const mod = (n: number, m: number) => ((n % m) + m) % m
  /** Where a frame is in its breath at document time `at` (ms into the cycle). */
  const phase = (index: number, mountedAt: number, at: number) => mod(at - mountedAt - latentDelay(index, mountedAt), LATENT_CYCLE_MS)

  it('locks every frame to one clock, however late it was mounted', () => {
    expect(phase(7, 1_000, 50_000)).toBeCloseTo(phase(7, 23_456.5, 50_000), 6)
    // One breath in and out is a whole cycle: the same frame is back where it was.
    expect(phase(7, 1_000, 50_000 + LATENT_CYCLE_MS)).toBeCloseTo(phase(7, 1_000, 50_000), 6)
  })

  it('puts each frame 160 ms behind the one before, so the wave runs toward the newest', () => {
    const lag = mod(phase(7, 1_000, 60_000) - phase(8, 9_000, 60_000), LATENT_CYCLE_MS)
    expect(lag).toBeCloseTo(160, 6)
  })

  it('starts every frame mid-breath: the delay is never positive', () => {
    for (const [index, at] of [[0, 0], [3, 12_345.6], [999, 4_800], [42, 1e9]] as const) {
      const delay = latentDelay(index, at)
      expect(delay).toBeLessThanOrEqual(0)
      expect(delay).toBeGreaterThan(-LATENT_CYCLE_MS)
    }
  })
})

describe('rowMonthPrint', () => {
  it('prints a row’s month as edge print, 2020·11', () => {
    expect(rowMonthPrint('2020-11-03')).toBe('2020·11')
  })
})

describe('followTarget: where the live sheet scrolls to show a row', () => {
  const geometry = { rowH: 114.5, gap: 9, padTop: 20, padBottom: 24, viewport: 300, total: 20 * 114.5 }

  it('brings the row’s strip and the bottom padding to the bottom of the view', () => {
    // Row 5 ends at 20 + 5 × 114.5 + 105.5 = 698; plus 24 of padding, less the 300 px view.
    expect(followTarget(5, geometry)).toBeCloseTo(698 + 24 - 300, 6)
  })

  it('never scrolls above the top or past the end', () => {
    expect(followTarget(0, geometry)).toBe(0)
    expect(followTarget(19, { ...geometry, total: 19.5 * 114.5 })).toBeCloseTo(20 + 19.5 * 114.5 + 24 - 300, 6)
  })
})

// Critique round 4, P2-16: "◐ 41 unsure" stood beside "Nothing needs your eye", and "0 remembered" showed.
describe('libraryTally', () => {
  const counts: LibraryCounts = { total: 3593, confirmed: 3529, uncertain: 41, rejected: 15, noFace: 8, failed: 0, reviewPending: 41, included: 3529, days: 3500, activeDays: 3500 }
  const decided = (kept: number, leftOut: number) => [
    ...Array.from({ length: kept }, () => ({ review: 'confirmed' as const })),
    ...Array.from({ length: leftOut }, () => ({ review: 'rejected' as const })),
  ]
  const shape = (items: ReturnType<typeof libraryTally>) => items.map((t) => `${t.kind} ${t.count} ${t.label}`)

  it('while unsure photos wait: you, unsure and someone else, with zeros hidden', () => {
    expect(shape(libraryTally(counts, [], 0))).toEqual(['you 3529 you', 'unsure 41 unsure', 'other 23 someone else or no face'])
  })

  it('after review: you include the kept, and kept and left out replace unsure', () => {
    const after = { ...counts, reviewPending: 0, included: 3558 }
    expect(shape(libraryTally(after, decided(29, 12), 0))).toEqual([
      'you 3558 you',
      'kept 29 kept',
      'leftOut 12 left out',
      'other 23 someone else or no face',
    ])
  })

  it('shows remembered and unreadable photos only when there are some', () => {
    const items = libraryTally({ ...counts, failed: 2 }, [], 412)
    expect(items.map((t) => t.kind)).toEqual(['you', 'unsure', 'other', 'cache', 'failed'])
    expect(items.at(-1)?.label).toBe('couldn’t be read')
  })
})

describe('liveTally', () => {
  it('keeps you, unsure and someone else on the line from the start, so it never reflows', () => {
    const items = liveTally({ confirmed: 0, uncertain: 0, rejected: 0, noFace: 0, fromCache: 0, failed: 0 })
    expect(items.map((t) => `${t.kind} ${t.count}`)).toEqual(['you 0', 'unsure 0', 'other 0'])
  })

  it('adds remembered and unreadable photos at the end once there are some', () => {
    const items = liveTally({ confirmed: 2174, uncertain: 27, rejected: 22, noFace: 8, fromCache: 412, failed: 1 })
    expect(items.map((t) => `${t.kind} ${t.count}`)).toEqual(['you 2174', 'unsure 27', 'other 30', 'cache 412', 'failed 1'])
    expect(items[3]?.label).toBe('remembered from the last scan')
  })
})

// QA §12 item 21: the library sheet had a tab stop per cell; it is one stop with arrow keys.
describe('rovingTarget: arrow keys across the library sheet', () => {
  // 23 photos in rows of 10: the last row holds 20–22.
  const move = (key: string, from: number) => rovingTarget(key, from, 23, 10)

  it('moves by one across a row and by a row up and down', () => {
    expect(move('ArrowRight', 4)).toBe(5)
    expect(move('ArrowLeft', 4)).toBe(3)
    expect(move('ArrowDown', 4)).toBe(14)
    expect(move('ArrowUp', 14)).toBe(4)
  })

  it('goes to the first and last photo with Home and End', () => {
    expect(move('Home', 17)).toBe(0)
    expect(move('End', 3)).toBe(22)
  })

  it('stays put at the edges, and steps down into a short last row at its end', () => {
    expect(move('ArrowLeft', 0)).toBe(0)
    expect(move('ArrowRight', 22)).toBe(22)
    expect(move('ArrowUp', 3)).toBe(3)
    expect(move('ArrowDown', 15)).toBe(22)
    expect(move('ArrowDown', 21)).toBe(21)
  })

  it('leaves every other key alone', () => {
    expect(move('Enter', 3)).toBeNull()
    expect(move('a', 3)).toBeNull()
    expect(rovingTarget('ArrowDown', 0, 0, 10)).toBeNull()
  })
})

// Critique round 5, P2-9: photos are read in no order of date, so the live ribbon's
// focus year followed the last photo read and jumped (2022, 2017, 2016 …) every row.
describe('liveFocusYear: the live ribbon holds one year', () => {
  it('focuses the year with the most days found so far', () => {
    expect(liveFocusYear(['2016-01-02', '2017-03-04', '2016-05-06'], null)).toBe(2016)
  })

  it('holds its year until another has strictly more days, so a tie never flips it', () => {
    // Arrange: 2016 is held; 2019 catches up.
    const tied = ['2016-01-02', '2016-01-03', '2019-01-02', '2019-01-03']

    // Act + Assert
    expect(liveFocusYear(tied, 2016)).toBe(2016)
    expect(liveFocusYear([...tied, '2019-07-08'], 2016)).toBe(2019)
  })

  it('takes the later year when it has to choose between equals, and keeps a year when nothing is found yet', () => {
    expect(liveFocusYear(['2013-01-01', '2021-01-01'], null)).toBe(2021)
    expect(liveFocusYear([], 2018)).toBe(2018)
    expect(liveFocusYear([], null)).toBeNull()
  })
})
