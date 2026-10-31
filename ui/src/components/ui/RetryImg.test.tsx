// QA finding 1: a thumbnail that fails (e.g. the image server sheds load with
// 503 while a whole year opens) must recover on its own, but only while the
// cell is mounted and visible, with a short backoff and a hard limit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { RETRY_DELAYS_MS, RetryImg, withRetryParam } from './RetryImg'

const SRC = 'ftimg://localhost/thumb/0123456789abcdef?w=160&v=5d0c9e8b'

/** A controllable IntersectionObserver: tests decide what is on screen. */
class FakeObserver {
  static all: FakeObserver[] = []
  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeObserver.all.push(this)
  }
  target: Element | null = null
  observe(el: Element) {
    this.target = el
  }
  unobserve() {}
  disconnect() {
    this.target = null
  }
  show(visible: boolean) {
    if (!this.target) return
    this.cb([{ isIntersecting: visible, target: this.target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeObserver.all = []
  vi.stubGlobal('IntersectionObserver', FakeObserver)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const img = () => screen.getByRole('img', { name: 'Thumb' }) as HTMLImageElement

describe('withRetryParam', () => {
  it('adds a cache-bust parameter the image server ignores', () => {
    expect(withRetryParam(SRC, 0)).toBe(SRC)
    expect(withRetryParam(SRC, 2)).toBe(`${SRC}&r=2`)
    expect(withRetryParam('http://ftimg.localhost/reference/frame', 1)).toBe('http://ftimg.localhost/reference/frame?r=1')
  })
})

describe('RetryImg', () => {
  it('retries a failed image with backoff, then gives up quietly', () => {
    render(<RetryImg src={SRC} alt="Thumb" />)
    FakeObserver.all[0]?.show(true)
    for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
      fireEvent.error(img())
      act(() => {
        vi.advanceTimersByTime(delay - 1)
      })
      expect(img().getAttribute('src')).toBe(withRetryParam(SRC, i))
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(img().getAttribute('src')).toBe(withRetryParam(SRC, i + 1))
    }
    fireEvent.error(img())
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(img().getAttribute('src')).toBe(withRetryParam(SRC, RETRY_DELAYS_MS.length))
    expect(img()).toHaveAttribute('data-failed', 'true')
  })

  it('waits while the cell is off screen and retries when it comes back', () => {
    render(<RetryImg src={SRC} alt="Thumb" />)
    const io = FakeObserver.all[0]
    io?.show(false)
    fireEvent.error(img())
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(img().getAttribute('src')).toBe(SRC)
    act(() => io?.show(true))
    expect(img().getAttribute('src')).toBe(withRetryParam(SRC, 1))
  })

  it('stops retrying once unmounted, and starts over for a new source', () => {
    const { rerender, unmount } = render(<RetryImg src={SRC} alt="Thumb" />)
    FakeObserver.all[0]?.show(true)
    fireEvent.error(img())
    rerender(<RetryImg src={`${SRC}x`} alt="Thumb" />)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(img().getAttribute('src')).toBe(`${SRC}x`)
    fireEvent.error(img())
    unmount()
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
  })

  it('a successful load clears the failed state', () => {
    render(<RetryImg src={SRC} alt="Thumb" />)
    FakeObserver.all[0]?.show(true)
    fireEvent.error(img())
    act(() => {
      vi.advanceTimersByTime(RETRY_DELAYS_MS[0] ?? 0)
    })
    fireEvent.load(img())
    expect(img()).not.toHaveAttribute('data-failed')
  })
})

// N3 (WebKit memory): a removed <img> keeps its decoded bitmap, and WebKit's
// cache entry for it stays live, until the element is garbage-collected. The
// image lets go of its source as it unmounts, so leaving a year of Days frees
// that year's thumbnails at once.
describe('RetryImg releases its image', () => {
  it('drops the source when it unmounts', () => {
    const { unmount } = render(<RetryImg src={SRC} alt="Thumb" />)
    const node = img()
    unmount()
    expect(node.hasAttribute('src')).toBe(false)
  })

  it('gives the loading hint before the source, so a lazy image waits until it is near the view', () => {
    const order: string[] = []
    const setAttribute = vi.spyOn(HTMLImageElement.prototype, 'setAttribute').mockImplementation(function (this: HTMLImageElement, name: string, value: string) {
      order.push(name)
      Element.prototype.setAttribute.call(this, name, value)
    })
    render(<RetryImg src={SRC} alt="Thumb" loading="lazy" />)
    setAttribute.mockRestore()
    expect(order.indexOf('loading')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('loading')).toBeLessThan(order.lastIndexOf('src'))
  })
})

describe('RetryImg under StrictMode', () => {
  it('keeps its source through the mount, unmount, mount of development builds', () => {
    render(
      <StrictMode>
        <RetryImg src={SRC} alt="Thumb" />
      </StrictMode>,
    )
    expect(img().getAttribute('src')).toBe(SRC)
  })

  it('still shows a new source after a re-render', () => {
    const { rerender } = render(
      <StrictMode>
        <RetryImg src={SRC} alt="Thumb" />
      </StrictMode>,
    )
    rerender(
      <StrictMode>
        <RetryImg src={`${SRC}x`} alt="Thumb" />
      </StrictMode>,
    )
    expect(img().getAttribute('src')).toBe(`${SRC}x`)
  })
})

// UI review 2, H1: removing the old source before setting the new one painted
// the background until the new picture loaded (the aligning frame blinked on
// every progress event, the reference print went blank after Level).
describe('RetryImg source changes are a plain swap', () => {
  it('never removes the source on a re-render or a retry, only on unmount', () => {
    const { rerender, unmount } = render(<RetryImg src={SRC} alt="Thumb" />)
    const node = img()
    const removed = vi.spyOn(node, 'removeAttribute')

    rerender(<RetryImg src={`${SRC}x`} alt="Thumb" />)
    expect(removed).not.toHaveBeenCalledWith('src')
    expect(node.getAttribute('src')).toBe(`${SRC}x`)

    unmount()
    expect(removed).toHaveBeenCalledWith('src')
  })
})
