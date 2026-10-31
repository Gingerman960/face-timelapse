// Request routing for the mock image server (`/__mock/img/...`), mirroring the
// `ftimg` protocol rules of ARCHITECTURE §6 with SVG bodies. Pure: the Vite
// middleware in `vite/mockImages.ts` only adapts it to Node's req/res.
import { type MockImageRoute, renderMockSvg } from './portraits'

export const MOCK_IMAGE_BASE = '/__mock/img/'

export interface MockImageResponse {
  status: number
  headers: Readonly<Record<string, string>>
  body: string
}

const PHOTO_ID = /^[0-9a-f]{16}$/
const WIDTH = /^[1-9]\d{0,4}$/
const IMMUTABLE = 'public, max-age=31536000, immutable'

function text(status: number, body: string, extra: Record<string, string> = {}): MockImageResponse {
  return {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
    body,
  }
}

function parseRoute(rest: string): { route: MockImageRoute; id: string | null } | null {
  if (rest === 'reference') return { route: 'reference', id: null }
  if (rest === 'reference/frame') return { route: 'referenceFrame', id: null }
  const m = /^(thumb|aligned|preview)\/([^/]+)$/.exec(rest)
  if (!m) return null
  // v1.7 `preview/{id}` draws the aligned stand-in (its `v` packs the render state).
  return { route: m[1] === 'thumb' ? 'thumb' : 'aligned', id: m[2] ?? null }
}

/**
 * Handles one request. Returns null when the URL is not under `/__mock/img/`
 * (the middleware passes it on). Unknown routes or ids → 404, non-GET → 405,
 * a non-numeric `w` → 400.
 */
export function handleMockImageRequest(method: string, rawUrl: string): MockImageResponse | null {
  const url = new URL(rawUrl, 'http://localhost')
  if (!url.pathname.startsWith(MOCK_IMAGE_BASE)) return null
  if (method.toUpperCase() !== 'GET') return text(405, 'Method not allowed', { Allow: 'GET' })

  const parsed = parseRoute(url.pathname.slice(MOCK_IMAGE_BASE.length))
  if (!parsed) return text(404, 'Not found')
  if (parsed.id !== null && !PHOTO_ID.test(parsed.id)) return text(404, 'Unknown photo')

  const rawWidth = url.searchParams.get('w')
  if (rawWidth !== null && !WIDTH.test(rawWidth)) return text(400, 'w must be a positive integer')
  const width = rawWidth === null ? null : Number(rawWidth)
  const version = url.searchParams.get('v')

  const body = renderMockSvg(parsed.route, parsed.id, width, version)
  if (body === null) return text(404, 'Unknown photo')
  return {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': version ? IMMUTABLE : 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
    body,
  }
}
