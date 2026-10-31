import { describe, expect, it } from 'vitest'
import {
  CAPTION_FORMATS,
  addDays,
  dayIndex,
  dayKeyFromFileName,
  dayKeyOf,
  dayRange,
  daysBetween,
  daysInMonth,
  daysInYear,
  formatDay,
  formatDayLong,
  formatDayShort,
  formatMonthYear,
  formatShortDate,
  formatTime,
  isAfterMidnightHint,
  isDayKey,
  knownTime,
  makeDayKey,
  monthGrid,
  parseDayKey,
  parseLocalDateTime,
  strftime,
  weekdayOf,
  weekdayShort,
  yearsInRange,
} from './dates'

describe('parsing', () => {
  it('parses valid day keys and rejects impossible ones', () => {
    expect(parseDayKey('2014-08-15')).toEqual({ year: 2014, month: 8, day: 15 })
    expect(parseDayKey('2016-02-29')).toEqual({ year: 2016, month: 2, day: 29 })
    expect(parseDayKey('2000-02-29')).not.toBeNull()
    for (const bad of ['1900-02-29', '2015-02-29', '2014-13-01', '2014-00-10', '2014-04-31', '2014-05-00', '2014-5-1', '20140815', '']) {
      expect(parseDayKey(bad)).toBeNull()
    }
    expect(isDayKey('2014-08-15')).toBe(true)
    expect(isDayKey('2014-08-32')).toBe(false)
  })

  it('parses naive local date-times without time zones', () => {
    expect(parseLocalDateTime('2014-08-15T21:07:05')).toEqual({
      year: 2014, month: 8, day: 15, hour: 21, minute: 7, second: 5,
    })
    for (const bad of ['2014-08-15T24:00:00', '2014-08-15T12:60:00', '2014-08-15T12:00:60', '2014-02-30T10:00:00', '2014-08-15 21:07:05', '2014-08-15T21:07:05Z']) {
      expect(parseLocalDateTime(bad)).toBeNull()
    }
    expect(dayKeyOf('2014-08-15T00:30:00')).toBe('2014-08-15')
    expect(dayKeyOf('2014-12-31T23:59:59')).toBe('2014-12-31')
    expect(() => dayKeyOf('2014-08-15')).toThrow(RangeError)
  })

  it('builds day keys from parts', () => {
    expect(makeDayKey(2014, 5, 2)).toBe('2014-05-02')
    expect(() => makeDayKey(2014, 2, 30)).toThrow(RangeError)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2023, 2)).toBe(28)
    expect(daysInMonth(2023, 4)).toBe(30)
    expect(daysInMonth(2023, 12)).toBe(31)
  })
})

describe('arithmetic', () => {
  it('adds days across months, years and leap days', () => {
    expect(addDays('2016-02-28', 1)).toBe('2016-02-29')
    expect(addDays('2016-02-29', 1)).toBe('2016-03-01')
    expect(addDays('2014-12-31', 1)).toBe('2015-01-01')
    expect(addDays('2014-01-01', -1)).toBe('2013-12-31')
    expect(addDays('1970-01-01', -1)).toBe('1969-12-31')
    expect(addDays('2012-01-01', 3653)).toBe('2022-01-01')
    expect(addDays('2014-08-15', 0)).toBe('2014-08-15')
  })

  it('counts days between and from a start', () => {
    expect(daysBetween('2012-01-01', '2022-01-01')).toBe(3653)
    expect(daysBetween('2022-01-01', '2012-01-01')).toBe(-3653)
    expect(dayIndex('2014-08-15', '2012-08-17')).toBe(728)
    expect(dayIndex('2012-08-17', '2012-08-17')).toBe(0)
    expect(() => daysBetween('2014-02-30', '2014-03-01')).toThrow(RangeError)
  })

  it('lists consecutive days and counts the days of a year', () => {
    expect(dayRange('2016-02-27', 4)).toEqual(['2016-02-27', '2016-02-28', '2016-02-29', '2016-03-01'])
    expect(dayRange('2014-12-31', 2)).toEqual(['2014-12-31', '2015-01-01'])
    expect(dayRange('2014-05-02', 0)).toEqual([])
    expect(dayRange('2014-05-02', -3)).toEqual([])
    expect(dayRange('2012-01-01', 3653).at(-1)).toBe('2021-12-31')
    expect(() => dayRange('2014-02-30', 1)).toThrow(RangeError)
    expect([daysInYear(2014), daysInYear(2016), daysInYear(1900), daysInYear(2000)]).toEqual([365, 366, 365, 366])
  })

  it('round-trips the civil-day conversion over centuries', () => {
    for (let n = -200_000; n <= 200_000; n += 997) {
      expect(daysBetween('2000-03-01', addDays('2000-03-01', n))).toBe(n)
    }
  })
})

describe('weekdays and grids', () => {
  it('names weekdays', () => {
    expect(weekdayOf('2014-05-02')).toBe('Friday')
    expect(weekdayOf('1970-01-01')).toBe('Thursday')
    expect(weekdayOf('1969-12-28')).toBe('Sunday')
    expect(weekdayShort('2017-03-03')).toBe('Fri')
    expect(weekdayShort('2024-02-26')).toBe('Mon')
  })

  it('lays months out Monday first with pads', () => {
    const may = monthGrid(2014, 5)
    expect(may).toHaveLength(5)
    expect(may[0]).toEqual([null, null, null, '2014-05-01', '2014-05-02', '2014-05-03', '2014-05-04'])
    expect(may[4]).toEqual(['2014-05-26', '2014-05-27', '2014-05-28', '2014-05-29', '2014-05-30', '2014-05-31', null])
    const feb = monthGrid(2021, 2)
    expect(feb).toHaveLength(4)
    expect(feb.flat().every((cell) => cell !== null)).toBe(true)
    expect(monthGrid(2015, 3)).toHaveLength(6)
    expect(() => monthGrid(2015, 13)).toThrow(RangeError)
  })

  it('lists the years in a range', () => {
    expect(yearsInRange('2012-08-17', '2015-01-02')).toEqual([2012, 2013, 2014, 2015])
    expect(yearsInRange('2015-01-02', '2012-08-17')).toEqual([2012, 2013, 2014, 2015])
    expect(yearsInRange('2014-01-01', '2014-12-31')).toEqual([2014])
  })
})

describe('formatters', () => {
  it('formats days in English', () => {
    expect(formatDay('2014-05-02')).toBe('2 May 2014')
    expect(formatDay('2014-08-14')).toBe('14 Aug 2014')
    expect(formatDayLong('2014-04-29')).toBe('29 April 2014')
    expect(formatDayShort('2017-03-03')).toBe('Fri 3 Mar 2017')
    expect(formatMonthYear('2014-05-20')).toBe('May 2014')
    expect(formatShortDate('2014-08-14')).toBe('14 Aug')
    expect(formatTime('2014-08-15T21:07:59')).toBe('21:07')
    expect(formatTime('2014-08-15T03:04:00')).toBe('03:04')
    expect(() => formatDay('nope')).toThrow(RangeError)
  })

  it('implements the chrono strftime subset', () => {
    const day = '2014-08-05'
    expect(strftime('%Y %m %d %-d %e %y', day)).toBe('2014 08 05 5  5 14')
    expect(strftime('%b %B %a %A', day)).toBe('Aug August Tue Tuesday')
    expect(strftime('100%% %Y', day)).toBe('100% 2014')
    expect(strftime('%e', '2014-08-15')).toBe('15')
    expect(strftime('%y', '2005-01-01')).toBe('05')
    expect(strftime('%Q %-m 50%', day)).toBe('%Q %-m 50%')
    expect(strftime('', day)).toBe('')
  })

  it('renders every caption preset', () => {
    const day = '2014-08-15'
    expect(CAPTION_FORMATS.map((f) => strftime(f, day))).toEqual([
      '15 Aug 2014', 'Aug 15, 2014', '2014-08-15', 'Aug 2014', '2014',
    ])
  })

  it('hints after-midnight photos', () => {
    const at = (takenAt: string) => ({ takenAt, timeKnown: true })
    expect(isAfterMidnightHint(at('2014-05-02T00:10:00'))).toBe(true)
    expect(isAfterMidnightHint(at('2014-05-02T03:59:59'))).toBe(true)
    expect(isAfterMidnightHint(at('2014-05-02T04:00:00'))).toBe(false)
    expect(isAfterMidnightHint(at('2014-05-02T21:07:00'))).toBe(false)
    expect(isAfterMidnightHint(at('garbage'))).toBe(false)
  })

  // Contract v1.4: a date-only file name is dated 00:00, which is no time at all.
  it('never hints a photo whose time of day is unknown', () => {
    expect(isAfterMidnightHint({ takenAt: '2022-08-27T00:00:00', timeKnown: false })).toBe(false)
  })

  it('shows a time only when it is known, never "00:00" for a date-only photo', () => {
    expect(knownTime({ takenAt: '2014-08-15T21:07:14', timeKnown: true })).toBe('21:07')
    expect(knownTime({ takenAt: '2014-05-02T00:41:12', timeKnown: true })).toBe('00:41')
    expect(knownTime({ takenAt: '2022-08-27T00:00:00', timeKnown: false })).toBeNull()
    expect(knownTime({ takenAt: '2021-05-30T12:00:00', timeKnown: false })).toBeNull()
  })
})

// Critique round 2: the Review's reference caption shows a date, like the candidate's.
describe('dayKeyFromFileName', () => {
  it('reads a camera-style date from a file name', () => {
    expect(dayKeyFromFileName('IMG_20140815_142326.jpg')).toBe('2014-08-15')
    expect(dayKeyFromFileName('20120901_111216.jpg')).toBe('2012-09-01')
    expect(dayKeyFromFileName('PXL_20220827.jpg')).toBe('2022-08-27')
  })

  it('finds no date where there is none or it is impossible', () => {
    expect(dayKeyFromFileName('Window_no_face.jpg')).toBeNull()
    expect(dayKeyFromFileName('IMG_20141315_000000.jpg')).toBeNull()
    expect(dayKeyFromFileName('FB_IMG_1408110000000.jpg')).toBeNull()
  })
})
