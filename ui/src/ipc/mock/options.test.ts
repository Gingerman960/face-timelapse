import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MOCK_OPTIONS, isFailPoint, parseFailures, parseMockOptions, resolveMockOptions } from './options'

describe('mock options', () => {
  it('defaults to the restored session at normal speed, with path grants enforced in the browser', () => {
    // URL-driven (dev, Playwright) runs enforce v1.3 grants; ?grants=off relaxes them.
    expect(parseMockOptions('')).toEqual({ ...DEFAULT_MOCK_OPTIONS, strictGrants: true })
    expect(parseMockOptions('?grants=off').strictGrants).toBe(false)
    expect(DEFAULT_MOCK_OPTIONS.strictGrants).toBe(false)
    expect(DEFAULT_MOCK_OPTIONS).toMatchObject({ scenario: 'aligned', speed: 'normal', alignFailures: 3 })
  })

  it('parses the Playwright URLs', () => {
    expect(parseMockOptions('?mock=fresh&speed=fast')).toMatchObject({ scenario: 'fresh', speed: 'fast', fail: {} })
    expect(parseMockOptions('?mock=ready&fail=start_scan:permissionDenied').fail).toEqual({
      start_scan: 'permissionDenied',
    })
    expect(
      parseMockOptions('?fail=set_reference_photo:noFaceInReference,start_export_video:diskFull,scanMidway:io').fail,
    ).toEqual({ set_reference_photo: 'noFaceInReference', start_export_video: 'diskFull', scanMidway: 'io' })
    expect(parseMockOptions('?dialogs=cancel&alignFailures=0')).toMatchObject({ cancelDialogs: true, alignFailures: 0 })
  })

  it('ignores unknown values with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(parseMockOptions('?mock=nope&speed=warp&alignFailures=x')).toEqual({ ...DEFAULT_MOCK_OPTIONS, strictGrants: true })
    expect(parseFailures('bogus:busy,start_scan:nope,start_scan')).toEqual({})
    expect(warn).toHaveBeenCalledTimes(3)
    expect(parseFailures(null)).toEqual({})
  })

  it('resolves partial options', () => {
    expect(resolveMockOptions({ speed: 'instant' })).toEqual({ ...DEFAULT_MOCK_OPTIONS, speed: 'instant' })
    expect(isFailPoint('alignMidway')).toBe(true)
    expect(isFailPoint('get_session')).toBe(true)
    expect(isFailPoint('nope')).toBe(false)
  })
})
