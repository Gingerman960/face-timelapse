import { describe, it, expect } from 'vitest'
import { generateFilename } from '../electron/services/exportService.js'

describe('generateFilename', () => {
  it('produces YYYYMMDD.png from an ISO date string', () => {
    const used = new Set()
    const name = generateFilename('2024-03-07T12:34:56.000Z', used)
    // The date is converted through local-time Date, but the month/day pattern must be correct length
    expect(name).toMatch(/^\d{8}\.png$/)
  })

  it('appends _1 on first collision and _2 on the next', () => {
    const used = new Set()
    const first = generateFilename('2024-03-07T00:00:00Z', used)
    used.add(first)
    const second = generateFilename('2024-03-07T00:00:00Z', used)
    used.add(second)
    const third = generateFilename('2024-03-07T00:00:00Z', used)

    expect(first).toMatch(/^\d{8}\.png$/)
    expect(second).toMatch(/^\d{8}_1\.png$/)
    expect(third).toMatch(/^\d{8}_2\.png$/)
  })

  it('falls back to today when date is invalid', () => {
    const name = generateFilename('not-a-date', new Set())
    expect(name).toMatch(/^\d{8}\.png$/)
  })

  it('falls back to today when date is null/undefined', () => {
    expect(generateFilename(null, new Set())).toMatch(/^\d{8}\.png$/)
    expect(generateFilename(undefined, new Set())).toMatch(/^\d{8}\.png$/)
  })
})
