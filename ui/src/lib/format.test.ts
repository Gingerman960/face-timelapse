import { describe, expect, it } from 'vitest'
import {
  PLACEHOLDER,
  formatBytes,
  formatCount,
  formatDuration,
  formatEta,
  formatEv,
  formatPercent,
  formatRate,
  formatTimecode,
  formatZone,
  pluralize,
  thisMachine,
  countOf,
  formatElapsed,
  formatLength,
} from './format'

describe('formatCount', () => {
  it('groups thousands and rounds', () => {
    expect(formatCount(3593)).toBe('3,593')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1234567.4)).toBe('1,234,567')
    expect(formatCount(-1204)).toBe('−1,204')
    expect(formatCount(-0.2)).toBe('0')
    expect(formatCount(Number.NaN)).toBe(PLACEHOLDER)
  })
})

describe('formatDuration and formatEta', () => {
  it('uses s, min s and h min', () => {
    expect(formatDuration(36_000)).toBe('36 s')
    expect(formatDuration(400)).toBe('0 s')
    expect(formatDuration(92_000)).toBe('1 min 32 s')
    expect(formatDuration(120_000)).toBe('2 min')
    expect(formatDuration(59_600)).toBe('1 min')
    expect(formatDuration(3_840_000)).toBe('1 h 4 min')
    expect(formatDuration(3_600_000)).toBe('1 h')
    expect(formatDuration(-5)).toBe('0 s')
    expect(formatDuration(Number.NaN)).toBe('0 s')
  })

  it('phrases ETAs', () => {
    expect(formatEta(36_000)).toBe('About 36 s left')
    expect(formatEta(92_000)).toBe('About 1 min 32 s left')
    expect(formatEta(1_200)).toBe('Almost done')
    expect(formatEta(null)).toBe('Estimating…')
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe('Estimating…')
  })
})

describe('formatTimecode', () => {
  it('prints minutes, seconds and tenths', () => {
    expect(formatTimecode(118.23)).toBe('01:58.2')
    expect(formatTimecode(0)).toBe('00:00.0')
    expect(formatTimecode(59.96)).toBe('01:00.0')
    expect(formatTimecode(3718.25)).toBe('1:01:58.3')
    expect(formatTimecode(-3)).toBe('00:00.0')
    expect(formatTimecode(Number.NaN)).toBe('00:00.0')
  })
})

describe('formatBytes', () => {
  it('uses decimal units', () => {
    expect(formatBytes(235_861_000)).toBe('236 MB')
    expect(formatBytes(980)).toBe('980 B')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999.6)).toBe('1 kB')
    expect(formatBytes(4_230_000_000)).toBe('4.2 GB')
    expect(formatBytes(1_000_000)).toBe('1 MB')
    expect(formatBytes(9_960_000)).toBe('10 MB')
    expect(formatBytes(999_400)).toBe('999 kB')
    expect(formatBytes(999_600)).toBe('1 MB')
    expect(formatBytes(3e15)).toBe('3,000 TB')
    expect(formatBytes(-1)).toBe(PLACEHOLDER)
    expect(formatBytes(Number.NaN)).toBe(PLACEHOLDER)
  })
})

describe('formatEv and formatZone', () => {
  it('rounds stops to the nearest third with a real minus', () => {
    expect(formatEv(0.66)).toBe('+⅔ EV')
    expect(formatEv(-1.34)).toBe('−1⅓ EV')
    expect(formatEv(0.1)).toBe('0 EV')
    expect(formatEv(-0.1)).toBe('0 EV')
    expect(formatEv(1)).toBe('+1 EV')
    expect(formatEv(0.4)).toBe('+⅓ EV')
    expect(formatEv(-2.7)).toBe('−2⅔ EV')
    expect(formatEv(Number.NaN)).toBe(PLACEHOLDER)
  })

  it('formats zones in thirds within 0–10', () => {
    expect(formatZone(5.33)).toBe('5⅓')
    expect(formatZone(6)).toBe('6')
    expect(formatZone(0.3)).toBe('⅓')
    expect(formatZone(0)).toBe('0')
    expect(formatZone(-1)).toBe('0')
    expect(formatZone(12)).toBe('10')
    expect(formatZone(Number.NaN)).toBe(PLACEHOLDER)
  })
})

describe('formatPercent, formatRate, pluralize', () => {
  it('formats percentages', () => {
    expect(formatPercent(0.342)).toBe('34%')
    expect(formatPercent(0.5)).toBe('50%')
    expect(formatPercent(0.1234, 1)).toBe('12.3%')
    expect(formatPercent(-0.25)).toBe('−25%')
    expect(formatPercent(-0.001)).toBe('0%')
    expect(formatPercent(Number.NaN)).toBe(PLACEHOLDER)
  })

  it('formats throughput', () => {
    expect(formatRate(38.4, 'photos')).toBe('38 photos/s')
    expect(formatRate(2.5, 'frames')).toBe('2.5 frames/s')
    expect(formatRate(3, 'frames')).toBe('3 frames/s')
    expect(formatRate(1234, 'photos')).toBe('1,234 photos/s')
    expect(formatRate(-1, 'photos')).toBe('0 photos/s')
    expect(formatRate(Number.NaN, 'photos')).toBe(`${PLACEHOLDER} photos/s`)
  })

  it('picks singular or plural words', () => {
    expect(pluralize(1, 'photo')).toBe('photo')
    expect(pluralize(0, 'photo')).toBe('photos')
    expect(pluralize(3, 'day')).toBe('days')
    expect(pluralize(2, 'person', 'people')).toBe('people')
  })
})

describe('thisMachine', () => {
  it('names the computer the way each platform does', () => {
    expect(thisMachine('macos')).toBe('this Mac')
    expect(thisMachine('windows')).toBe('this PC')
    expect(thisMachine('linux')).toBe('this computer')
    expect(thisMachine(undefined)).toBe('this Mac')
  })
})

describe('countOf', () => {
  it('pairs a formatted count with the right noun', () => {
    expect(countOf(1, 'photo')).toBe('1 photo')
    expect(countOf(0, 'photo')).toBe('0 photos')
    expect(countOf(3591, 'photo')).toBe('3,591 photos')
    expect(countOf(2, 'day', 'days')).toBe('2 days')
  })
})

describe('formatLength and formatElapsed (one length format: ledger and transport)', () => {
  it('rounds a length and counts elapsed whole seconds, with hours past an hour', () => {
    expect(formatLength(179.6)).toBe('3:00')
    expect(formatElapsed(179.6)).toBe('2:59')
    expect(formatLength(3725)).toBe('1:02:05')
    expect(formatLength(Number.NaN)).toBe('0:00')
    expect(formatElapsed(-4)).toBe('0:00')
  })
})
