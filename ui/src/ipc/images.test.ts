import { describe, expect, it } from 'vitest'
import { ALIGNED_WIDTHS, REFERENCE_FRAME_WIDTHS, REFERENCE_WIDTHS, THUMB_WIDTHS } from './contract'
import { alignedUrl, bucketWidth, referenceFrameUrl, referenceUrl, thumbUrl } from './images'

const BASE = 'ftimg://localhost/'

describe('bucketWidth', () => {
  it('rounds up to the next bucket', () => {
    expect(bucketWidth(THUMB_WIDTHS, 100, 1)).toBe(160)
    expect(bucketWidth(THUMB_WIDTHS, 160, 1)).toBe(160)
    expect(bucketWidth(THUMB_WIDTHS, 161, 1)).toBe(320)
    expect(bucketWidth(THUMB_WIDTHS, 160, 2)).toBe(320)
    expect(bucketWidth(THUMB_WIDTHS, 320 / 3, 3)).toBe(320)
    expect(bucketWidth(ALIGNED_WIDTHS, 700, 2)).toBe(1280)
  })

  it('caps at the largest bucket and guards bad input', () => {
    expect(bucketWidth(THUMB_WIDTHS, 5000, 2)).toBe(2048)
    expect(bucketWidth(REFERENCE_WIDTHS, 0, 2)).toBe(320)
    expect(bucketWidth(REFERENCE_WIDTHS, Number.NaN, 1)).toBe(320)
    expect(bucketWidth(THUMB_WIDTHS, 200, 0)).toBe(320)
    expect(bucketWidth(THUMB_WIDTHS, 200, Number.NaN)).toBe(320)
    expect(() => bucketWidth([], 100, 1)).toThrow(RangeError)
  })
})

describe('URL builders', () => {
  it('builds bucketed URLs for every route', () => {
    expect(thumbUrl(BASE, { id: '0123456789abcdef', version: 'v1' }, 72, 2)).toBe(
      'ftimg://localhost/thumb/0123456789abcdef?w=160&v=v1',
    )
    expect(alignedUrl(BASE, { photoId: '0123456789abcdef', version: 'f9' }, 600, 2)).toBe(
      'ftimg://localhost/aligned/0123456789abcdef?w=1280&v=f9',
    )
    expect(referenceUrl(BASE, 'r1', 900, 2)).toBe('ftimg://localhost/reference?w=2048&v=r1')
    expect(referenceFrameUrl('http://ftimg.localhost/', 'r2', 300, 1)).toBe(
      'http://ftimg.localhost/reference/frame?w=320&v=r2',
    )
    expect(REFERENCE_FRAME_WIDTHS[0]).toBe(160)
  })

  it('requests the master frame only for an explicit null width', () => {
    expect(alignedUrl(BASE, { photoId: '0123456789abcdef', version: 'f9' }, null, 2)).toBe(
      'ftimg://localhost/aligned/0123456789abcdef?v=f9',
    )
  })
})
