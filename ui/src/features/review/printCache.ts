// Decoded prints for Review (critique round 4, P1-4). The next candidates'
// thumbnails are decoded before they are needed, so a decision never shows a
// half-loaded print. Holding the decoded image keeps its bitmap in the
// webview's memory cache; a released image gives its source up, which cancels
// a load still running and lets the bitmap go.

/** The print shown, the one leaving, and the next two. */
export const PRINT_CACHE_SIZE = 4

interface Entry {
  img: HTMLImageElement
  ready: Promise<boolean>
  decoded: boolean
}

/** Most recently used last. A resource cache, so it lives with the module, not in React state. */
const entries = new Map<string, Entry>()

function release(src: string): void {
  const entry = entries.get(src)
  if (!entry) return
  entry.img.removeAttribute('src')
  entries.delete(src)
}

function trim(): void {
  for (const src of entries.keys()) {
    if (entries.size <= PRINT_CACHE_SIZE) return
    release(src)
  }
}

/**
 * Resolves once `src` is decoded: true, or false when it failed to load (it
 * is forgotten, so the next call tries again; a shown print retries itself).
 */
export function decodePrint(src: string): Promise<boolean> {
  const hit = entries.get(src)
  if (hit) {
    entries.delete(src)
    entries.set(src, hit)
    return hit.ready
  }
  const img = new Image()
  img.decoding = 'async'
  img.src = src
  const decoding = typeof img.decode === 'function' ? img.decode() : Promise.resolve()
  // Only the entry still holding this image may change (a released one stays released).
  const ready = decoding.then(
    () => {
      const now = entries.get(src)
      if (now?.img === img) entries.set(src, { ...now, decoded: true })
      return true
    },
    () => {
      if (entries.get(src)?.img === img) entries.delete(src)
      return false
    },
  )
  entries.set(src, { img, ready, decoded: false })
  trim()
  return ready
}

/** True once `src` has been decoded (and is still held). */
export function isPrintDecoded(src: string): boolean {
  return entries.get(src)?.decoded === true
}

/** Releases every held print except `wanted`. */
export function keepPrints(wanted: Iterable<string>): void {
  const keep = new Set(wanted)
  for (const src of [...entries.keys()]) if (!keep.has(src)) release(src)
}
