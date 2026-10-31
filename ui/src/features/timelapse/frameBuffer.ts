import { withRetryParam } from '../../components/ui/RetryImg'

/**
 * A bounded set of decoded frames. `img.decode()` decodes off the main thread
 * (JPEG from ftimg:// and the SVG stand-ins of the mock alike), so drawing a
 * ready frame onto the canvas never stalls playback.
 */
type EntryState = 'loading' | 'ready' | 'failed'

interface Entry {
  readonly img: HTMLImageElement | null
  readonly state: EntryState
}

type ImageFactory = () => HTMLImageElement

/**
 * Decoded frames the player may hold at once (HIGH-3). A 1280 px frame is
 * about 8.7 MB decoded, so the budget, not the frame count, bounds the
 * window at large sizes (21 frames); small frames keep the full window.
 */
export const DECODED_BUDGET_BYTES = 192e6
/** Frames preloaded ahead and behind while playing, and around a paused frame, when the budget allows. */
const AHEAD_PLAYING = 48
const BEHIND_PLAYING = 8
const AROUND_PAUSED = 12
/** The window never shrinks below this many frames (±4 around a paused one). */
const MIN_WINDOW = 9
/** Failed urls remembered (so each is retried once); the oldest are forgotten first. */
const MAX_FAILURES = 1024
const BYTES_PER_PIXEL = 4

/** Bytes a decoded frame `width` px wide with width ÷ height `aspect` occupies (RGBA). */
export function decodedFrameBytes(width: number, aspect: number): number {
  return width * Math.round(width / aspect) * BYTES_PER_PIXEL
}

/**
 * How many frames to preload ahead and behind the playhead so that they, plus
 * `extra` other frames (the onion skin's reference), fit DECODED_BUDGET_BYTES.
 */
export function preloadWindow(playing: boolean, frameBytes: number, extra = 0): { ahead: number; behind: number } {
  const fits = frameBytes > 0 ? Math.floor(DECODED_BUDGET_BYTES / frameBytes) - extra : Number.POSITIVE_INFINITY
  const cap = Math.max(MIN_WINDOW, fits)
  if (playing) {
    const behind = Math.min(BEHIND_PLAYING, Math.floor(cap / 8))
    return { ahead: Math.min(AHEAD_PLAYING, cap - 1 - behind), behind }
  }
  const around = Math.min(AROUND_PAUSED, Math.floor((cap - 1) / 2))
  return { ahead: around, behind: around }
}

/**
 * A frame that failed is loaded again once when it comes back into the window
 * (with a cache-bust parameter, like RetryImg, so the webview asks the server
 * again instead of reusing the failure), then given up on.
 */
const MAX_RETRIES = 1

export class FrameBuffer {
  private entries = new Map<string, Entry>()
  private queue: string[] = []
  private active = 0
  /** Failed loads per url; kept when a frame leaves the window so it is retried only once. */
  private failures = new Map<string, number>()
  private readonly onSettle: (url: string) => void

  /** `onSettle` runs when a wanted frame finishes decoding or fails. */
  constructor(
    onSettle: (url: string) => void,
    private readonly maxConcurrent = 6,
    private readonly makeImage: ImageFactory = () => new Image(),
  ) {
    this.onSettle = onSettle
  }

  /** The decoded image for `url`, or null if it is not ready yet. */
  get(url: string): HTMLImageElement | null {
    const e = this.entries.get(url)
    return e?.state === 'ready' ? e.img : null
  }

  /** True when `url` failed to load or decode (the player skips it). */
  failed(url: string): boolean {
    return this.entries.get(url)?.state === 'failed'
  }

  /** Queues `urls` (first = most urgent) and drops everything not listed, cancelling their downloads. */
  want(urls: readonly string[]): void {
    const keep = new Set(urls)
    for (const [url, entry] of [...this.entries]) {
      if (!keep.has(url)) this.drop(url, entry)
    }
    const queue: string[] = []
    for (const url of urls) {
      if (this.entries.has(url)) continue
      if ((this.failures.get(url) ?? 0) > MAX_RETRIES) this.entries.set(url, { img: null, state: 'failed' })
      else queue.push(url)
    }
    this.queue = queue
    this.pump()
  }

  /** Drops every frame and cancels downloads (unmount). The buffer can be used again afterwards. */
  dispose(): void {
    for (const [url, entry] of [...this.entries]) this.drop(url, entry)
    this.queue = []
    this.failures = new Map()
  }

  /** Number of entries held (decoded, failed or in flight). */
  get size(): number {
    return this.entries.size
  }

  private drop(url: string, entry: Entry): void {
    this.entries.delete(url)
    if (entry.state === 'loading') this.active--
    // An image without a source stops downloading and frees its decoded pixels.
    if (entry.img) entry.img.src = ''
  }

  private recordFailure(url: string): void {
    const count = (this.failures.get(url) ?? 0) + 1
    this.failures.delete(url)
    this.failures.set(url, count)
    const oldest = this.failures.keys().next()
    if (this.failures.size > MAX_FAILURES && !oldest.done) this.failures.delete(oldest.value)
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const url = this.queue.shift()
      if (url !== undefined && !this.entries.has(url)) this.load(url)
    }
  }

  private load(url: string): void {
    const img = this.makeImage()
    img.decoding = 'async'
    const entry: Entry = { img, state: 'loading' }
    this.entries.set(url, entry)
    this.active++
    img.src = withRetryParam(url, this.failures.get(url) ?? 0)
    img.decode().then(
      () => this.settle(url, entry, 'ready'),
      () => this.settle(url, entry, 'failed'),
    )
  }

  private settle(url: string, entry: Entry, state: 'ready' | 'failed'): void {
    // A dropped frame already gave its slot back; a late decode must not count.
    if (this.entries.get(url) !== entry) return
    this.active--
    this.entries.set(url, { img: entry.img, state })
    if (state === 'failed') this.recordFailure(url)
    this.onSettle(url)
    this.pump()
  }
}

/**
 * Indices to preload around `index`: ahead in the playing direction first,
 * then behind. With `wrap` (looped playback) the window continues past the
 * ends, so the frames after the loop point are ready in time.
 */
export function windowIndices(index: number, count: number, direction: 1 | -1, ahead = 48, behind = 16, wrap = false): number[] {
  if (count <= 0) return []
  const out: number[] = []
  const seen = new Set<number>()
  const add = (i: number) => {
    const j = wrap ? ((i % count) + count) % count : i
    if (j < 0 || j >= count || seen.has(j)) return
    seen.add(j)
    out.push(j)
  }
  for (let k = 0; k <= ahead; k++) add(index + direction * k)
  for (let k = 1; k <= behind; k++) add(index - direction * k)
  return out
}
