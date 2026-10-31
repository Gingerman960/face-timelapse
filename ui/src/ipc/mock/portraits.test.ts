import { describe, expect, it } from 'vitest'
import { RESTORED_CROP, demoLibrary, extraPhotos } from './fixtures'
import { MOCK_IMAGE_BASE, handleMockImageRequest } from './imageRoutes'
import { DEFAULT_FRAME_PARAMS, alignedTransform, renderMockSvg } from './portraits'
import { applyAffine } from './geometry'
import { anchorsPx, detectionFor, referenceGeometry } from './faces'
import { encodeFrameVersion, encodeReferenceFrameVersion, encodeReferenceImageVersion } from './versions'

const lib = demoLibrary()
const photo = lib.photos.find((p) => p.status === 'confirmed' && p.size.width > p.size.height)!
const portrait = lib.photos.find((p) => p.size.width < p.size.height)!
const noFace = lib.photos.find((p) => p.status === 'noFace')!
const group = lib.photos.find((p) => p.faces.length === 3)!

function dims(svg: string): { width: number; height: number; viewBox: string } {
  const m = /<svg[^>]* width="(\d+)" height="(\d+)" viewBox="([^"]+)"/.exec(svg)
  if (!m) throw new Error('no svg header')
  return { width: Number(m[1]), height: Number(m[2]), viewBox: m[3] ?? '' }
}

describe('renderMockSvg', () => {
  it('draws thumbs at the photo aspect, fit inside w×w, in source pixels', () => {
    const svg = renderMockSvg('thumb', photo.id, 320)!
    expect(dims(svg)).toEqual({
      width: 320,
      height: Math.round((320 * photo.size.height) / photo.size.width),
      viewBox: `0 0 ${photo.size.width} ${photo.size.height}`,
    })
    expect(dims(renderMockSvg('thumb', portrait.id, 320)!).height).toBe(320)
    expect(dims(renderMockSvg('thumb', photo.id, null)!).width).toBe(2048)
  })

  it('puts the subject between the matched eye anchors', () => {
    const svg = renderMockSvg('thumb', photo.id, 640)!
    const face = photo.faces[photo.matchedFace!]!
    const [le, re] = anchorsPx(face, photo.size)
    const mid = { x: (le!.x + re!.x) / 2, y: (le!.y + re!.y) / 2 }
    const m = /<g transform="matrix\(([-\d. ]+)\)">/.exec(svg)
    const [, , , , e, f] = (m?.[1] ?? '').split(' ').map(Number)
    expect(e).toBeCloseTo(mid.x, 0)
    expect(f).toBeCloseTo(mid.y, 0)
  })

  it('is deterministic and draws one person per face', () => {
    expect(renderMockSvg('thumb', group.id, 320)).toBe(renderMockSvg('thumb', group.id, 320))
    expect(renderMockSvg('thumb', group.id, 320)!.match(/<g transform="matrix/g)).toHaveLength(3)
    expect(renderMockSvg('thumb', noFace.id, 320)).not.toContain('<g transform="matrix')
    expect(renderMockSvg('thumb', extraPhotos()[0]!.id, 160)).toContain('<svg')
  })

  it('returns null for unknown ids', () => {
    expect(renderMockSvg('thumb', '0000000000000000', 320)).toBeNull()
    expect(renderMockSvg('aligned', null, 320)).toBeNull()
  })

  it('draws aligned frames at the output aspect with the eyes on the reference anchors', () => {
    const svg = renderMockSvg('aligned', photo.id, 320)!
    expect(dims(svg)).toEqual({ width: 320, height: 427, viewBox: '0 0 1080 1440' })
    const { out, transform } = alignedTransform(photo, DEFAULT_FRAME_PARAMS)
    const target = detectionFor(referenceGeometry(0, true), RESTORED_CROP)!.anchors
    const face = photo.faces[photo.matchedFace!]!
    const mapped = anchorsPx(face, photo.size).map((p) => applyAffine(transform, p))
    expect(mapped[0]!.x / out.width).toBeCloseTo(target[0]!.x, 1)
    expect(mapped[1]!.y / out.height).toBeCloseTo(target[1]!.y, 1)
    expect(dims(renderMockSvg('aligned', photo.id, null)!).width).toBe(1080)
  })

  it('reads look, backdrop, adjust and crop from the frame version', () => {
    const base = { ...DEFAULT_FRAME_PARAMS }
    const off = renderMockSvg('aligned', photo.id, 160, encodeFrameVersion('a', base))!
    const evened = renderMockSvg(
      'aligned',
      photo.id,
      160,
      encodeFrameVersion('a', { ...base, look: { normalize: 'exposureAndColor', strength: 1 } }),
    )!
    expect(evened).not.toBe(off)
    expect(renderMockSvg('aligned', photo.id, 160, encodeFrameVersion('b', { ...base, backdrop: 'black' }))).toContain(
      'fill="#000"/>',
    )
    expect(renderMockSvg('aligned', photo.id, 160, encodeFrameVersion('c', { ...base, backdrop: 'blurred' }))).toContain(
      'filter="url(#blur)"',
    )
    const square = encodeFrameVersion('d', { ...base, crop: { x: 400, y: 0, width: 2368, height: 2368 } })
    expect(dims(renderMockSvg('aligned', photo.id, 160, square)!).viewBox).toBe('0 0 1080 1080')
    const noRef = encodeFrameVersion('e', { ...base, variant: 'noFace' })
    expect(renderMockSvg('aligned', noFace.id, 160, noRef)).toContain('<svg')
    expect(renderMockSvg('aligned', photo.id, 160, 'garbage')).toBe(renderMockSvg('aligned', photo.id, 160))
  })

  it('draws the reference and its crop', () => {
    const ref = renderMockSvg('reference', null, 640)!
    expect(dims(ref)).toEqual({ width: 640, height: 474, viewBox: '0 0 3200 2368' })
    const rotated = renderMockSvg('reference', null, 640, encodeReferenceImageVersion('r', { rotationDeg: 10, variant: 'portrait' }))!
    expect(dims(rotated).viewBox).not.toBe('0 0 3200 2368')
    const blank = renderMockSvg('reference', null, 320, encodeReferenceImageVersion('r', { rotationDeg: 0, variant: 'noFace' }))!
    expect(blank).not.toContain('<g transform="matrix')
    const frame = renderMockSvg('referenceFrame', null, 320)!
    expect(dims(frame)).toEqual({ width: 320, height: 427, viewBox: '746 0 1664 2219' })
    const square = encodeReferenceFrameVersion('s', { rotationDeg: 0, crop: { x: 0, y: 0, width: 2368, height: 2368 }, variant: 'portrait' })
    expect(dims(renderMockSvg('referenceFrame', null, 320, square)!).height).toBe(320)
  })
})

describe('handleMockImageRequest', () => {
  const url = (path: string) => `${MOCK_IMAGE_BASE}${path}`

  it('serves SVG with immutable caching when v is present', () => {
    const res = handleMockImageRequest('GET', url(`thumb/${photo.id}?w=320&v=${photo.version}`))!
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toBe('image/svg+xml')
    expect(res.headers['Cache-Control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*')
    expect(res.body.startsWith('<svg')).toBe(true)
    expect(handleMockImageRequest('GET', url(`aligned/${photo.id}`))!.headers['Cache-Control']).toBe('no-store')
    expect(handleMockImageRequest('GET', url('reference?w=640&v=x'))!.status).toBe(200)
    expect(handleMockImageRequest('GET', url('reference/frame?w=160'))!.status).toBe(200)
    expect(handleMockImageRequest('GET', url(`preview/${photo.id}?w=640&v=ab12`))!.status).toBe(200)
  })

  it('rejects unknown routes and ids, bad widths and other methods', () => {
    expect(handleMockImageRequest('GET', url('thumb/0000000000000000'))!.status).toBe(404)
    expect(handleMockImageRequest('GET', url('thumb/not-an-id'))!.status).toBe(404)
    expect(handleMockImageRequest('GET', url('nope'))!.status).toBe(404)
    expect(handleMockImageRequest('GET', url(`thumb/${photo.id}?w=abc`))!.status).toBe(400)
    expect(handleMockImageRequest('GET', url(`thumb/${photo.id}?w=0`))!.status).toBe(400)
    const post = handleMockImageRequest('POST', url(`thumb/${photo.id}`))!
    expect(post.status).toBe(405)
    expect(post.headers.Allow).toBe('GET')
    expect(handleMockImageRequest('GET', '/src/main.tsx')).toBeNull()
  })
})
