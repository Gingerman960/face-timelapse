import { describe, expect, it, vi } from 'vitest'
import { nextShuttle, usePlayer } from '../../state/player'
import { withRetryParam } from '../../components/ui/RetryImg'
import { FrameBuffer, windowIndices } from './frameBuffer'

class FakeImage {
  src = ''
  decoding = 'auto'
  static fail = new Set<string>()
  /** Every src decode was called for, in order. */
  static decoded: string[] = []
  decode(): Promise<void> {
    FakeImage.decoded.push(this.src)
    return FakeImage.fail.has(this.src) ? Promise.reject(new Error('bad')) : Promise.resolve()
  }
}
const make = () => new FakeImage() as unknown as HTMLImageElement
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('FrameBuffer', () => {
  it('decodes wanted frames with bounded concurrency and reports readiness', async () => {
    const ready = vi.fn()
    const b = new FrameBuffer(ready, 2, make)
    b.want(['a', 'b', 'c'])
    expect(b.size).toBe(2)
    expect(b.get('a')).toBeNull()
    await flush()
    await flush()
    expect(ready).toHaveBeenCalledTimes(3)
    expect(b.get('c')).not.toBeNull()
  })

  it('drops frames that are no longer wanted and remembers failures', async () => {
    FakeImage.fail.add('bad')
    const b = new FrameBuffer(() => undefined, 4, make)
    b.want(['x', 'bad'])
    await flush()
    expect(b.failed('bad')).toBe(true)
    expect(b.get('bad')).toBeNull()
    b.want(['y'])
    expect(b.get('x')).toBeNull()
    expect(b.failed('nope')).toBe(false)
  })
})

describe('windowIndices', () => {
  it('preloads ahead in the playing direction first', () => {
    expect(windowIndices(5, 100, 1, 3, 2)).toEqual([5, 6, 7, 8, 4, 3])
    expect(windowIndices(5, 100, -1, 2, 1)).toEqual([5, 4, 3, 6])
    expect(windowIndices(0, 2, 1, 5, 5)).toEqual([0, 1])
    expect(windowIndices(0, 0, 1)).toEqual([])
  })

  it('wraps past the ends for looped playback, without repeats', () => {
    expect(windowIndices(8, 10, 1, 3, 1, true)).toEqual([8, 9, 0, 1, 7])
    expect(windowIndices(1, 10, -1, 3, 1, true)).toEqual([1, 0, 9, 8, 2])
    expect(windowIndices(0, 3, 1, 10, 10, true)).toEqual([0, 1, 2])
  })
})

describe('player shuttle', () => {
  it('J/K/L start, double and stop like an editing deck', () => {
    expect(nextShuttle(false, 1, 'l')).toEqual({ playing: true, rate: 1 })
    expect(nextShuttle(true, 1, 'l')).toEqual({ playing: true, rate: 2 })
    expect(nextShuttle(true, 8, 'l')).toEqual({ playing: true, rate: 8 })
    expect(nextShuttle(true, 2, 'j')).toEqual({ playing: true, rate: -1 })
    expect(nextShuttle(true, -1, 'j')).toEqual({ playing: true, rate: -2 })
    expect(nextShuttle(true, -4, 'k')).toEqual({ playing: false, rate: 1 })
  })
  it('steps and toggles', () => {
    const s = usePlayer.getState()
    s.setIndex(5)
    s.step(10, 8)
    expect(usePlayer.getState().index).toBe(7)
    s.step(-100, 8)
    expect(usePlayer.getState().index).toBe(0)
    s.toggle()
    expect(usePlayer.getState().playing).toBe(true)
    s.pause()
    expect(usePlayer.getState().playing).toBe(false)
    s.shuttle('l')
    expect(usePlayer.getState().playing).toBe(true)
    s.setLoop(false)
    s.setViewer(true)
    expect(usePlayer.getState()).toMatchObject({ loop: false, viewer: true })
  })
})

describe('FrameBuffer failures and cleanup', () => {
  /** Images whose decode never settles (still downloading). */
  class SlowImage {
    src = ''
    decoding = 'auto'
    decode(): Promise<void> {
      return new Promise(() => undefined)
    }
  }

  // Regression (M5): a failure used to be retried every time the frame came back into the window.
  it('retries a failed frame once when it re-enters the window, then reports it failed without loading', async () => {
    // Arrange
    FakeImage.fail.add('broken')
    FakeImage.fail.add(withRetryParam('broken', 1))
    const attempts = () => FakeImage.decoded.filter((src) => src.startsWith('broken')).length
    const b = new FrameBuffer(() => undefined, 4, make)

    // Act + Assert: first failure.
    b.want(['broken'])
    await flush()
    expect(b.failed('broken')).toBe(true)
    b.want(['broken', 'other'])
    await flush()
    expect(attempts()).toBe(1)

    // Act + Assert: it leaves and re-enters: one retry.
    b.want(['other'])
    expect(b.failed('broken')).toBe(false)
    b.want(['broken'])
    await flush()
    expect(attempts()).toBe(2)
    expect(b.failed('broken')).toBe(true)

    // Act + Assert: after the retry it is not loaded again, but still reported failed.
    b.want(['other'])
    b.want(['broken'])
    await flush()
    expect(attempts()).toBe(2)
    expect(b.failed('broken')).toBe(true)
  })

  // QA 1: the retry asked for the same URL, which the webview may answer from the failed load it cached.
  it('the retry asks again with a cache-bust parameter and the frame is kept under its own URL', async () => {
    // Arrange
    const url = 'ftimg://localhost/aligned/abc?w=480&v=1'
    FakeImage.fail.add(url)
    const settled = vi.fn()
    const b = new FrameBuffer(settled, 4, make)
    b.want([url])
    await flush()
    expect(b.failed(url)).toBe(true)

    // Act: it leaves and comes back; the server has recovered.
    b.want([])
    b.want([url])
    await flush()

    // Assert
    expect(FakeImage.decoded.filter((src) => src.startsWith(url))).toEqual([url, withRetryParam(url, 1)])
    expect(b.get(url)).not.toBeNull()
    expect(b.failed(url)).toBe(false)
    expect(settled).toHaveBeenLastCalledWith(url)
  })

  it('stops downloading frames that leave the window and frees their slots', () => {
    // Arrange
    const made: SlowImage[] = []
    const b = new FrameBuffer(() => undefined, 2, () => {
      const img = new SlowImage()
      made.push(img)
      return img as unknown as HTMLImageElement
    })
    b.want(['a', 'b', 'c'])
    expect(made.map((i) => i.src)).toEqual(['a', 'b'])

    // Act
    b.want(['c', 'd'])

    // Assert
    expect(made.slice(0, 2).map((i) => i.src)).toEqual(['', ''])
    expect(made.slice(2).map((i) => i.src)).toEqual(['c', 'd'])
    expect(b.size).toBe(2)
  })

  it('dispose drops everything and ignores late decodes; the buffer can be used again', async () => {
    // Arrange
    let resolve: () => void = () => undefined
    const ready = vi.fn()
    const b = new FrameBuffer(ready, 4, () => ({ src: '', decoding: 'auto', decode: () => new Promise<void>((r) => (resolve = r)) }) as unknown as HTMLImageElement)
    b.want(['a'])

    // Act
    b.dispose()
    resolve()
    await flush()

    // Assert
    expect(b.size).toBe(0)
    expect(ready).not.toHaveBeenCalled()
    b.want(['a'])
    resolve()
    await flush()
    expect(ready).toHaveBeenCalledWith('a')
  })
})
