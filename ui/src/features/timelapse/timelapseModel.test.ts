import { describe, expect, it } from 'vitest'
import { alignMessage, exposureChange, fitBand, fitScaleAt, fitWords, formatVideoLength, formatVideoTime, framesLine, framesSubtitle, sheetSummary, stripKeyTarget, zoneLabel, zoneSpeech } from './timelapseModel'

// QA 5: counts read correctly at 1. Critique round 6, P2-7: a chosen day is counted as a day, never a frame.
describe('count lines', () => {
  it('the subtitle says "1 day"', () => {
    expect(framesSubtitle(1, '2014-08-14', '2014-08-14')).toBe('1 day · 14 Aug 2014 – 14 Aug 2014')
    expect(framesSubtitle(3547, null, null)).toBe('3,547 days')
  })

  it('the sheet bar says "1 day"', () => {
    expect(sheetSummary(1, 0)).toBe('1 day · all within 3× the median fit')
    expect(sheetSummary(3547, 11)).toBe('3,547 days · 11 to check')
  })

  it('the align announcements say "1 day"', () => {
    expect(alignMessage(true, 0, 0, 0)).toBe('Aligning started.')
    expect(alignMessage(true, 1, 1, 0)).toBe('Aligning. 1 of 1 day.')
    expect(alignMessage(true, 120, 3547, 0)).toBe('Aligning. 120 of 3,547 days.')
    expect(alignMessage(false, 1, 1, 1)).toBe('Alignment finished. 1 day.')
    expect(alignMessage(false, 3547, 3547, 3547)).toBe('Alignment finished. 3,547 days.')
  })
})

// Critique round 4, item 4: the ledger read "3:00" and the transport "02:59.6".
describe('video times in the ledger’s length format', () => {
  it('prints a length as the ledger does: minutes and seconds, rounded to the second', () => {
    expect(formatVideoLength(179.6)).toBe('3:00')
    expect(formatVideoLength(355.7)).toBe('5:56')
    expect(formatVideoLength(4.4)).toBe('0:04')
    expect(formatVideoLength(0)).toBe('0:00')
    expect(formatVideoLength(3725)).toBe('1:02:05')
    expect(formatVideoLength(Number.NaN)).toBe('0:00')
  })

  it('prints the playhead’s time in whole seconds reached, so it reads the length only at the end', () => {
    expect(formatVideoTime(179.6)).toBe('2:59')
    expect(formatVideoTime(2)).toBe('0:02')
    expect(formatVideoTime(59.99)).toBe('0:59')
    expect(formatVideoTime(3600)).toBe('1:00:00')
    expect(formatVideoTime(-1)).toBe('0:00')
  })
})

// Critique round 4, P1-2: five position readouts became one line.
describe('the facts line', () => {
  // Critique round 6, P2-7: "Frame 3 of 3,547 · day 4" counted one thing two ways.
  it('reads "Day 1,439 of 3,573"', () => {
    expect(framesLine(1438, 3573)).toBe('Day 1,439 of 3,573')
    expect(framesLine(0, 1)).toBe('Day 1 of 1')
  })
})

// Critique round 4, item 19: "Alignment fit 4.6 px" had no scale.
describe('alignment fit bands', () => {
  it('measures a frame against the median fit: tight up to 1.5×, ok up to 3×, loose beyond', () => {
    expect(fitBand(1.2, 1.4)).toBe('tight')
    expect(fitBand(2.0, 1.4)).toBe('tight')
    expect(fitBand(2.2, 1.4)).toBe('ok')
    expect(fitBand(4.1, 1.4)).toBe('ok')
    expect(fitBand(4.3, 1.4)).toBe('loose')
  })

  it('has no scale without a median', () => {
    expect(fitBand(1.2, 0)).toBeNull()
    expect(fitBand(1.2, Number.NaN)).toBeNull()
  })

  it('places the pin on a scale three bands wide, holding at the loose end', () => {
    expect(fitScaleAt(0, 2)).toBe(0)
    expect(fitScaleAt(3, 2)).toBeCloseTo(1 / 3, 6)
    expect(fitScaleAt(6, 2)).toBeCloseTo(2 / 3, 6)
    expect(fitScaleAt(40, 2)).toBe(1)
  })

  it('flags the same frames the sheet does (over 3× the median)', () => {
    expect(fitBand(3.01, 1)).toBe('loose')
    expect(fitBand(3, 1)).toBe('ok')
  })
})

// Critique round 5, P2-12: the plate led with units ("Fit 4.6 px"); words come first.
describe('the fit in words', () => {
  it('says how tightly the day lines up, by band', () => {
    expect(fitWords('tight')).toBe('Tightly lined up')
    expect(fitWords('ok')).toBe('Lined up')
    expect(fitWords('loose')).toBe('Loosely lined up')
    expect(fitWords(null)).toBe('Lined up')
  })
})

// Critique round 5, P2-12: "+⅔ EV" became "Brightened ⅔ stop" (words first, units after).
describe('the exposure change in words', () => {
  it('brightens or darkens by thirds of a stop, singular up to one stop', () => {
    expect(exposureChange(2 / 3)).toEqual({ words: 'Brightened', amount: '⅔', unit: 'stop', text: 'Brightened ⅔ stop' })
    expect(exposureChange(1)).toMatchObject({ text: 'Brightened 1 stop' })
    expect(exposureChange(-4 / 3)).toEqual({ words: 'Darkened', amount: '1⅓', unit: 'stops', text: 'Darkened 1⅓ stops' })
    expect(exposureChange(2)).toMatchObject({ text: 'Brightened 2 stops' })
  })

  it('says the light was already even when the change rounds to nothing', () => {
    expect(exposureChange(0.1)).toEqual({ words: 'Already even', amount: null, unit: null, text: 'Already even' })
    expect(exposureChange(Number.NaN)).toMatchObject({ text: 'Already even' })
  })
})

// Critique round 4, item 24: the zone wedge was unlabelled; round 5, P2-12: in words first.
describe('the zone wedge label', () => {
  it('names where the face’s exposure moved from and to, in thirds', () => {
    expect(zoneLabel(2 / 3)).toBe('From zone 5 to 5⅔')
    expect(zoneLabel(-1)).toBe('From zone 5 to 4')
    expect(zoneSpeech(1 / 3)).toBe('Face exposure moved from zone 5 to 5⅓')
  })
})

// Critique round 4, item 21: one tab stop per strip, arrows inside it.
describe('filmstrip keys', () => {
  it('steps with the arrows (⇧ ten), jumps with Home and End, within the range', () => {
    expect(stripKeyTarget('ArrowRight', false, 5, 0, 99)).toBe(6)
    expect(stripKeyTarget('ArrowLeft', false, 5, 0, 99)).toBe(4)
    expect(stripKeyTarget('ArrowRight', true, 5, 0, 99)).toBe(15)
    expect(stripKeyTarget('ArrowLeft', true, 5, 0, 99)).toBe(0)
    expect(stripKeyTarget('Home', false, 5, 2, 99)).toBe(2)
    expect(stripKeyTarget('End', false, 5, 0, 99)).toBe(99)
    expect(stripKeyTarget('ArrowRight', false, 99, 0, 99)).toBe(99)
  })

  it('leaves every other key alone', () => {
    expect(stripKeyTarget('ArrowUp', false, 5, 0, 99)).toBeNull()
    expect(stripKeyTarget(' ', false, 5, 0, 99)).toBeNull()
    expect(stripKeyTarget('o', false, 5, 0, 99)).toBeNull()
  })
})
