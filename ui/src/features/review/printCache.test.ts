// Critique round 4, P1-4: the next prints are decoded before they are needed,
// with a hard bound on how many decoded bitmaps are held.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePrint, isPrintDecoded, keepPrints, PRINT_CACHE_SIZE } from './printCache'

const src = (n: number) => `ftimg://localhost/thumb/${String(n).padStart(16, '0')}?w=1280&v=1`

/** Records every image `decode()` is called on. */
function recordDecodes(result: () => Promise<void> = () => Promise.resolve()) {
  const images: HTMLImageElement[] = []
  const decode = vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (this: HTMLImageElement) {
    images.push(this)
    return result()
  })
  return { images, decode }
}

afterEach(() => {
  keepPrints([])
})

describe('decodePrint', () => {
  it('decodes each print once and shares the wait', async () => {
    // Arrange
    const { decode, images } = recordDecodes()

    // Act
    await Promise.all([decodePrint(src(1)), decodePrint(src(1))])

    // Assert
    expect(decode).toHaveBeenCalledTimes(1)
    expect(images[0]?.getAttribute('src')).toBe(src(1))
    expect(isPrintDecoded(src(1))).toBe(true)
  })

  it('is not decoded until the decode settles', async () => {
    let finish: () => void = () => undefined
    recordDecodes(() => new Promise<void>((resolve) => (finish = resolve)))
    const ready = decodePrint(src(2))
    expect(isPrintDecoded(src(2))).toBe(false)
    finish()
    await ready
    expect(isPrintDecoded(src(2))).toBe(true)
  })

  it('holds at most PRINT_CACHE_SIZE prints and lets the oldest go', async () => {
    // Arrange
    const { images } = recordDecodes()

    // Act
    for (let i = 0; i <= PRINT_CACHE_SIZE; i++) await decodePrint(src(i))

    // Assert: the first image gave up its source (its load and bitmap are released).
    expect(images).toHaveLength(PRINT_CACHE_SIZE + 1)
    expect(images[0]?.hasAttribute('src')).toBe(false)
    expect(isPrintDecoded(src(0))).toBe(false)
    expect(images.slice(1).every((img) => img.hasAttribute('src'))).toBe(true)
  })

  it('a failed decode still resolves (the print shows and retries itself) and is tried afresh next time', async () => {
    // Arrange
    const { decode } = recordDecodes(() => Promise.reject(new Error('503')))

    // Act + Assert
    await expect(decodePrint(src(3))).resolves.toBe(false)
    expect(isPrintDecoded(src(3))).toBe(false)
    await decodePrint(src(3))
    expect(decode).toHaveBeenCalledTimes(2)
  })
})

describe('keepPrints', () => {
  it('releases every print except the ones still wanted', async () => {
    // Arrange
    const { images } = recordDecodes()
    await decodePrint(src(1))
    await decodePrint(src(2))
    await decodePrint(src(3))

    // Act
    keepPrints([src(2)])

    // Assert
    expect(images.map((img) => img.hasAttribute('src'))).toEqual([false, true, false])
    expect(isPrintDecoded(src(2))).toBe(true)
  })
})
