import { describe, expect, it } from 'vitest'
import type { DayGroup, PhotoSummary } from '../../ipc/contract'
import { dayPhotos, faceCellStyle, inRange, indexDays, monthStats, movedMessage, spanSummary, shiftMonth, stepDay, tabStop, yearDays, yearMonths, yearStats, yearWeeks, yearColumns } from './daysModel'

const day = (dayKey: string, ids = ['a'], extra: Partial<DayGroup> = {}): DayGroup => ({
  dayKey,
  photoIds: ids,
  selectedId: ids[0] ?? 'a',
  autoSelectedId: ids[0] ?? 'a',
  manualSelection: false,
  excluded: false,
  ...extra,
})

describe('calendar math', () => {
  it('lists the days of a year', () => {
    expect(yearDays(2014)).toHaveLength(365)
    expect(yearDays(2016)).toHaveLength(366)
    expect(yearDays(2014)[0]).toBe('2014-01-01')
    expect(yearDays(2014).at(-1)).toBe('2014-12-31')
  })

  it('shifts to the first of another month across years', () => {
    expect(shiftMonth('2014-05-02', 1)).toBe('2014-06-01')
    expect(shiftMonth('2014-12-31', 1)).toBe('2015-01-01')
    expect(shiftMonth('2014-01-15', -1)).toBe('2013-12-01')
    expect(shiftMonth('2014-03-31', -14)).toBe('2013-01-01')
  })

  it('stops stepping at the ends of the range', () => {
    const range = { first: '2012-09-01', last: '2022-08-31' }
    expect(stepDay('2012-09-01', -1, range)).toBe('2012-09-01')
    expect(stepDay('2022-08-31', 7, range)).toBe('2022-08-31')
    expect(stepDay('2014-05-02', 7, range)).toBe('2014-05-09')
    expect(stepDay('2014-12-31', 1, { first: null, last: null })).toBe('2015-01-01')
    expect(inRange('2012-08-31', range)).toBe(false)
    expect(inRange('2014-05-02', { first: null, last: null })).toBe(true)
  })

  it('keeps one tab stop per view: the active day, else the first day in range', () => {
    const range = { first: '2012-09-01', last: '2022-08-31' }
    expect(tabStop('2014-05-02', '2014-01-01', '2014-12-31', range)).toBe('2014-05-02')
    expect(tabStop('2015-05-02', '2014-01-01', '2014-12-31', range)).toBe('2014-01-01')
    expect(tabStop(null, '2012-01-01', '2012-12-31', range)).toBe('2012-09-01')
    expect(tabStop('2012-05-02', '2012-01-01', '2012-12-31', range)).toBe('2012-09-01')
    expect(tabStop(null, '2023-01-01', '2023-12-31', range)).toBeNull()
    expect(tabStop(null, '2014-05-01', '2014-05-31', { first: null, last: null })).toBe('2014-05-01')
  })
})

describe('indexDays / yearStats', () => {
  const days = [day('2013-12-31'), day('2014-01-01', ['a', 'b']), day('2014-01-03'), day('2015-02-01')]
  it('indexes days and their year span', () => {
    const idx = indexDays(days)
    expect(idx.years).toEqual([2013, 2014, 2015])
    expect(idx.first).toBe('2013-12-31')
    expect(idx.byDay.get('2014-01-01')?.photoIds).toHaveLength(2)
    expect(indexDays([]).years).toEqual([])
  })
  it('counts days with a photo, alternates and empty days inside the range', () => {
    const idx = indexDays(days)
    const s = yearStats(2014, idx.byDay, { first: idx.first, last: idx.last })
    expect(s).toEqual({ withPhoto: 2, total: 365, alternates: 1, empty: 363, leftOut: 0 })
    const clipped = yearStats(2015, idx.byDay, { first: idx.first, last: idx.last })
    expect(clipped.total).toBe(32)
  })
})

describe('faceCellStyle', () => {
  it('crops a square around the face, kept inside the photo', () => {
    const s = faceCellStyle({ x: 0.4, y: 0.3, width: 0.2, height: 0.3 }, { width: 4000, height: 3000 })
    expect(s.position).toBe('absolute')
    expect(parseFloat(String(s.width))).toBeGreaterThan(100)
    expect(parseFloat(String(s.left))).toBeLessThanOrEqual(0)
    expect(parseFloat(String(s.top))).toBeLessThanOrEqual(0)
  })
  it('clamps at the photo edge and falls back to cover without a face', () => {
    const edge = faceCellStyle({ x: 0, y: 0, width: 0.2, height: 0.2 }, { width: 4000, height: 3000 })
    expect(edge.left).toBe('0%')
    expect(faceCellStyle(null, { width: 10, height: 10 })).toMatchObject({ objectFit: 'cover' })
    expect(faceCellStyle({ x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 0 })).toMatchObject({ objectFit: 'cover' })
  })
})

describe('dayPhotos', () => {
  it('returns the day photos in order, skipping unknown ids', () => {
    const p = { id: 'b' } as PhotoSummary
    expect(dayPhotos(day('2014-01-01', ['a', 'b']), new Map([['b', p]]))).toEqual([p])
    expect(dayPhotos(undefined, new Map())).toEqual([])
  })
})

describe('yearMonths (P1-2)', () => {
  const range = { first: '2012-09-14', last: '2022-08-31' }

  it('drops the months before the first photo and after the last one', () => {
    expect(yearMonths(2012, range)).toEqual({ months: [9, 10, 11, 12], before: '2012-09-14', after: null })
    expect(yearMonths(2022, range)).toEqual({ months: [1, 2, 3, 4, 5, 6, 7, 8], before: null, after: '2022-08-31' })
    expect(yearMonths(2016, range)).toEqual({ months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], before: null, after: null })
  })

  it('keeps every month without a library or outside it', () => {
    expect(yearMonths(2014, { first: null, last: null }).months).toHaveLength(12)
    expect(yearMonths(2030, range)).toEqual({ months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], before: null, after: null })
  })
})

describe('monthStats (P1-3)', () => {
  it('counts one month inside the range', () => {
    const idx = indexDays([day('2014-05-02', ['a', 'b']), day('2014-05-03'), day('2014-06-01')])
    expect(monthStats(2014, 5, idx.byDay, { first: '2014-05-02', last: '2014-06-01' })).toEqual({ withPhoto: 2, total: 30, alternates: 1, empty: 28, leftOut: 0 })
  })

  // Critique round 2: the summary didn't count days left out of the timelapse.
  it('counts days left out of the timelapse', () => {
    const idx = indexDays([{ ...day('2014-05-02'), excluded: true }, day('2014-05-03')])
    expect(monthStats(2014, 5, idx.byDay, { first: '2014-05-02', last: '2014-05-03' }).leftOut).toBe(1)
  })
})

describe('yearWeeks (P2-10)', () => {
  const groups = [day('2014-01-08', ['a'], { excluded: true }), day('2014-01-10', ['b']), day('2014-01-16', ['c'], { excluded: true }), day('2014-12-31', ['d'])]
  const idx = indexDays(groups)
  const weeks = yearWeeks(2014, idx.byDay, { first: '2014-01-08', last: '2014-12-31' })

  it('cuts the year into 53 seven-day weeks from 1 January', () => {
    expect(weeks).toHaveLength(53)
    expect(weeks[0]?.start).toBe('2014-01-01')
    expect(weeks[52]?.start).toBe('2014-12-31')
    expect(yearWeeks(2016, idx.byDay, { first: null, last: null })[52]?.start).toBe('2016-12-30')
  })

  it('shows the first kept photo of a week, else a left-out one, else nothing', () => {
    expect(weeks[0]).toMatchObject({ face: null, inRange: false })
    expect(weeks[1]).toMatchObject({ face: '2014-01-10', excluded: false, inRange: true })
    expect(weeks[2]).toMatchObject({ face: '2014-01-16', excluded: true })
    expect(weeks[3]).toMatchObject({ face: null, inRange: true })
  })

  it('can cut the year into two-week columns instead', () => {
    const pairs = yearWeeks(2014, idx.byDay, { first: '2014-01-08', last: '2014-12-31' }, 14)
    expect(pairs).toHaveLength(27)
    expect(pairs[1]).toMatchObject({ start: '2014-01-15', face: '2014-01-16', excluded: true })
    expect(pairs[0]).toMatchObject({ face: '2014-01-10', excluded: false, inRange: true })
  })

  it('marks the week where a new month begins', () => {
    const starts = weeks.filter((w) => w.monthStart).map((w) => w.start.slice(5, 7))
    expect(starts).toEqual(['02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'])
  })
})

// QA LOW: a dropped photo silently replaced the day's pick. The pick follows the
// best likeness (unless chosen by hand), so the toast now says what happened.
describe('movedMessage', () => {
  const group = (photoIds: string[], selectedId: string): DayGroup => ({
    dayKey: '2014-05-13',
    photoIds,
    selectedId,
    autoSelectedId: selectedId,
    manualSelection: false,
    excluded: false,
  })
  const patch = (day: DayGroup) => ({ upserted: [day], removed: [] })

  it('says the moved photo is now the pick when it took over', () => {
    expect(movedMessage(patch(group(['a', 'b'], 'b')), 'b', '2014-05-13')).toBe('Moved to 13 May 2014 · now the pick')
  })

  it('says it was added as an alternate when the pick stayed', () => {
    expect(movedMessage(patch(group(['a', 'b'], 'a')), 'b', '2014-05-13')).toBe('Moved to 13 May 2014 · added as an alternate')
  })

  it('says only where it went when it is the day’s only photo', () => {
    expect(movedMessage(patch(group(['b'], 'b')), 'b', '2014-05-13')).toBe('Moved to 13 May 2014')
    expect(movedMessage({ upserted: [], removed: [] }, 'b', '2014-05-13')).toBe('Moved to 13 May 2014')
  })
})

// Batch 3: "· 1 left out" wrapped the year head and pushed the calendar down; zero counts now drop out.
describe('spanSummary', () => {
  // Critique round 3: the summary counted left-out days as in; it now says what the timelapse gets.
  it('says how many days are in the timelapse, then the counts that are not zero', () => {
    expect(spanSummary({ withPhoto: 359, total: 365, alternates: 4, empty: 6, leftOut: 4 })).toBe('355 in the timelapse · 4 left out · 6 empty · 4 with alternates')
    expect(spanSummary({ withPhoto: 366, total: 366, alternates: 0, empty: 0, leftOut: 0 })).toBe('366 in the timelapse')
    expect(spanSummary({ withPhoto: 1, total: 1, alternates: 1, empty: 0, leftOut: 0 })).toBe('1 in the timelapse · 1 with alternates')
  })
})

// Critique round 4, P2-9: the month columns followed a window breakpoint, so cells
// fell to 16 px with the inspector open and the year scrolled even at 1920 px.
describe('yearColumns: month blocks per row follow the canvas', () => {
  it('by width alone: as many months as keep a day cell at 26 px or more, in a count that divides the year', () => {
    // A month at 26 px cells is 7 × 26 + 6 × 2 = 194 px; months sit 24 px apart.
    expect(yearColumns({ width: 1300, gap: 24 })).toMatchObject({ columns: 6, monthPx: null })
    expect(yearColumns({ width: 828, gap: 24 }).columns).toBe(3)
    expect(yearColumns({ width: 1000, gap: 24 }).columns).toBe(4)
    // Five would fit, but 12 months in rows of five leave a ragged last row: four.
    expect(yearColumns({ width: 1140, gap: 24 }).columns).toBe(4)
    expect(yearColumns({ width: 300, gap: 24 }).columns).toBe(1)
  })

  it('puts the whole year on one table with the largest cells that fit (1920 px: four columns, not six)', () => {
    const grid = yearColumns({ width: 1308, gap: 24, height: 860, rowGap: 20 })
    expect(grid.columns).toBe(4)
    expect(grid.cellPx).toBeGreaterThan(30)
    expect(grid.monthPx).toBeCloseTo(7 * grid.cellPx + 12)
    // A year at the library's edge (8 months and a note) gets bigger cells still, filling its columns.
    expect(yearColumns({ width: 1308, gap: 24, height: 860, rowGap: 20, months: 8, notesPx: 20 })).toMatchObject({ columns: 4, monthPx: null })
  })

  // Critique round 5, P1-5: at 1920 the year ended about 125 pt above the ribbon, as every month
  // row was sized for six weeks. Rows are sized by the weeks their months really have.
  it('sizes each row of months by the weeks they really have, so the year fills the height', () => {
    // 2013 in rows of four: 5, 5 and 6 weeks (Sep and Dec start on a Sunday).
    const weeks2013 = [5, 5, 5, 5, 5, 5, 5, 5, 6, 5, 5, 6]
    const six = yearColumns({ width: 1308, gap: 24, height: 860, rowGap: 20 })
    const real = yearColumns({ width: 1308, gap: 24, height: 860, rowGap: 20, monthWeeks: weeks2013 })
    expect(real.columns).toBe(4)
    expect(real.cellPx).toBeGreaterThan(six.cellPx + 3)
    // The rows exactly fill the height: three heads, 16 week rows and their gaps.
    const used = 3 * 54 + 16 * real.cellPx + (16 - 3) * 2 + 2 * 20
    expect(used).toBeCloseTo(860, 0)
  })

  it('scrolls with the most columns that keep 26 px when no layout fits the height', () => {
    expect(yearColumns({ width: 828, gap: 24, height: 680, rowGap: 20 })).toMatchObject({ columns: 3, monthPx: null })
  })

  it('never lets a cell fall under 26 px when one month fits, and never under the floor at all', () => {
    for (const width of [194, 420, 640, 828, 1181, 1300, 1600, 2400]) {
      for (const height of [Number.POSITIVE_INFINITY, 900, 500]) {
        expect(yearColumns({ width, gap: 24, height, rowGap: 20 }).cellPx).toBeGreaterThanOrEqual(26)
      }
    }
    expect(yearColumns({ width: 100, gap: 24 }).cellPx).toBeGreaterThanOrEqual(12)
  })
})
