// The contact sheet: the live scan's developing frontier and follow, edge print, and the
// library's keyboard.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubLayout } from '../../test/layout'
import { ContactSheet, type SheetItem } from './ContactSheet'

const items: SheetItem[] = Array.from({ length: 12 }, (_, i) => ({
  id: `p${i}`,
  version: 'v1',
  dayKey: `2014-01-${String(i + 1).padStart(2, '0')}`,
  label: `photo ${i}`,
}))

/** React listens for the prefixed name where there is no AnimationEvent (jsdom); browsers get `animationend`. */
function animationEnd(el: Element): void {
  act(() => {
    el.dispatchEvent(new Event('AnimationEvent' in window ? 'animationend' : 'webkitAnimationEnd', { bubbles: true }))
  })
}

function imgOf(container: HTMLElement, i: number): HTMLImageElement {
  const cell = container.querySelector(`[aria-label="photo ${i}"]`)
  return cell?.querySelector('img') as HTMLImageElement
}

/** Fires `load` on each frame's image, in the order given. */
function land(container: HTMLElement, ...frames: number[]): void {
  act(() => {
    for (const i of frames) fireEvent.load(imgOf(container, i))
  })
}

/** Fires `load` on frame `i`'s image (the sheets labelled "frame i"). */
function landFrame(container: HTMLElement, i: number): void {
  act(() => {
    fireEvent.load(container.querySelector(`[aria-label="frame ${i}"] img`) as HTMLImageElement)
  })
}

/** Ends each frame's develop (its image's animation), in the order given. */
function develop(container: HTMLElement, ...frames: number[]): void {
  for (const i of frames) animationEnd(imgOf(container, i))
}

// A failing fake-timer test must not leave fake timers to the tests after it.
afterEach(() => {
  vi.useRealTimers()
})

const liveSheet = () => <ContactSheet items={items} base="/__mock/img/" follow reading ariaLabel="Matched photos" />

// Critique round 5, P1-6: the outline followed the highest loaded index, so it jumped onto
// frames still black, and about three rows twinkled. Frames now develop in order along one
// leading edge, and the outline moves when a develop ends.
describe('ContactSheet live frontier', () => {
  it('outlines only a frame that has developed with every frame before it settled, never an empty slot', () => {
    // Arrange
    stubLayout(1200, 800)
    const { container } = render(liveSheet())
    const film = (i: number) => container.querySelector(`[aria-label="photo ${i}"]`)?.getAttribute('data-film')
    const outlined = () => Array.from(container.querySelectorAll('.frame-cell.newest')).map((c) => c.getAttribute('aria-label'))

    // Act + Assert: frame 2 lands first; it waits latent, and nothing is outlined.
    land(container, 2)
    expect(film(2)).toBe('latent')
    expect(outlined()).toEqual([])

    // The run 0–2 is complete: all three develop, still no outline.
    land(container, 0, 1)
    expect([film(0), film(1), film(2)]).toEqual(['fresh', 'fresh', 'fresh'])
    expect(outlined()).toEqual([])

    // Frame 2 finishes first, but frame 1 is still developing: the outline waits.
    develop(container, 2)
    expect(outlined()).toEqual([])
    develop(container, 0)
    expect(outlined()).toEqual(['photo 0'])
    develop(container, 1)
    expect(outlined()).toEqual(['photo 2'])
    expect(container.querySelector('.frame-cell.newest img')).not.toBeNull()
  })

  it('keeps early arrivals latent until the frames before them land, so the sheet develops along one edge', () => {
    // Arrange
    stubLayout(1200, 800)
    const { container } = render(liveSheet())
    const film = (i: number) => container.querySelector(`[aria-label="photo ${i}"]`)?.getAttribute('data-film')
    expect(items.map((_, i) => film(i))).toEqual(items.map(() => 'latent'))

    // Act: two frames far ahead land, one fails; then frame 0 lands.
    land(container, 1, 10)
    act(() => {
      fireEvent.error(imgOf(container, 11))
    })
    land(container, 0)

    // Assert: 0 and 1 develop; 10 waits behind 2–9; the failed frame ahead keeps breathing.
    expect(items.map((_, i) => film(i))).toEqual(['fresh', 'fresh', 'latent', 'latent', 'latent', 'latent', 'latent', 'latent', 'latent', 'latent', 'latent', 'latent'])

    // Act: the rest land.
    land(container, 2, 3, 4, 5, 6, 7, 8, 9)

    // Assert: the edge reaches the failed frame, which stops breathing.
    expect(film(10)).toBe('fresh')
    expect(film(11)).toBe('blank')
  })

  it('holds an early arrival for at most 400 ms, then lets the edge pass the frames still waiting', () => {
    // Arrange
    vi.useFakeTimers()
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    stubLayout(1200, 800)
    const { container } = render(liveSheet())
    const film = (i: number) => container.querySelector(`[aria-label="photo ${i}"]`)?.getAttribute('data-film')
    land(container, 3)

    // Act + Assert
    now += 399
    act(() => vi.advanceTimersByTime(399))
    expect(film(3)).toBe('latent')
    now += 1
    act(() => vi.advanceTimersByTime(1))
    expect(film(3)).toBe('fresh')
    // Frames 0–2 never landed: they keep breathing, and never carry the outline.
    expect([film(0), film(1), film(2)]).toEqual(['latent', 'latent', 'latent'])
    develop(container, 3)
    expect(container.querySelector('.frame-cell.newest')?.getAttribute('aria-label')).toBe('photo 3')
  })

  it('a batch released together sweeps along the edge: each develop starts a step after the one before', () => {
    // Arrange
    stubLayout(1200, 800)
    const { container } = render(liveSheet())
    const cell = (i: number) => container.querySelector<HTMLElement>(`[aria-label="photo ${i}"]`) as HTMLElement

    // Act
    land(container, 3, 2, 1, 0)

    // Assert
    const delays = [0, 1, 2, 3].map((i) => parseFloat(cell(i).style.getPropertyValue('--develop-delay')))
    expect(delays[0]).toBe(0)
    expect(delays.every((d, i) => i === 0 || d > (delays[i - 1] ?? 0))).toBe(true)
    expect(cell(0).style.getPropertyValue('--develop-dur')).toMatch(/^\d+ms$/)

    // Act: developed, the timing goes with the filter.
    develop(container, 0)

    // Assert
    expect(cell(0)).toHaveAttribute('data-film', 'fixed')
    expect(cell(0).style.getPropertyValue('--develop-delay')).toBe('')
  })

  it('the library view (not reading) has no outline and no film', () => {
    stubLayout(1200, 800)
    const { container } = render(<ContactSheet items={items} base="/__mock/img/" ariaLabel="Photos" />)
    fireEvent.load(imgOf(container, 0))
    expect(container.querySelector('.frame-cell.newest')).toBeNull()
    expect(container.querySelector('[data-film]')).toBeNull()
  })

  it('stops following when the user scrolls back, and Jump to newest or reaching the end resumes it', () => {
    // Arrange
    stubLayout(1200, 800)
    render(liveSheet())
    const sheet = screen.getByLabelText('Matched photos')

    // Act + Assert: a wheel back up and a key back up both unpin; the button pins again
    fireEvent.wheel(sheet, { deltaY: -120 })
    fireEvent.click(screen.getByRole('button', { name: 'Jump to newest' }))
    expect(screen.queryByRole('button', { name: 'Jump to newest' })).toBeNull()
    fireEvent.wheel(sheet, { deltaY: 120 })
    expect(screen.queryByRole('button', { name: 'Jump to newest' })).toBeNull()
    fireEvent.keyDown(sheet, { key: 'PageUp' })
    expect(screen.getByRole('button', { name: 'Jump to newest' })).toBeInTheDocument()

    // Act: scrolling down to the end resumes following
    fireEvent.keyDown(sheet, { key: 'j' })
    fireEvent.scroll(sheet)

    // Assert
    expect(screen.queryByRole('button', { name: 'Jump to newest' })).toBeNull()
  })
})

// Critique round 5, P2-9: live rows were stamped in read order (2022·01, 2017·08 …).
describe('ContactSheet edge print', () => {
  it('live rows print frame numbers only, on wide and narrow cells alike', () => {
    for (const width of [600, 2400]) {
      // Arrange + Act
      stubLayout(width, 800)
      const { container, unmount } = render(liveSheet())

      // Assert
      const edges = Array.from(container.querySelectorAll('.frame-cell .edge'))
      expect(edges.length).toBeGreaterThan(0)
      expect(edges.filter((e) => e.hasAttribute('data-day'))).toEqual([])
      expect(edges.every((e) => e.hasAttribute('data-n'))).toBe(true)
      unmount()
    }
  })

  // Critique round 4, P2-15: narrow cells keep only the number, but each row's first frame prints its month.
  it('the library drops the date on narrow cells, except the month on each row’s first frame', () => {
    // Arrange: 600 px gives 5 columns, so photos 0 and 5 start rows.
    stubLayout(600, 800)

    // Act
    const { container } = render(<ContactSheet items={items} base="/__mock/img/" ariaLabel="Photos" />)

    // Assert
    const edgeOf = (i: number) => container.querySelector(`[aria-label="photo ${i}"] .edge`)
    expect(edgeOf(0)).toHaveAttribute('data-day', '2014·01')
    expect(edgeOf(5)).toHaveAttribute('data-day', '2014·01')
    expect(edgeOf(1)).toHaveAttribute('data-n')
    expect(edgeOf(1)).not.toHaveAttribute('data-day')
  })

  it('the library prints the whole date on every wide cell', () => {
    stubLayout(2400, 800)
    const { container } = render(<ContactSheet items={items} base="/__mock/img/" ariaLabel="Photos" />)
    expect(container.querySelector('[aria-label="photo 3"] .edge')).toHaveAttribute('data-day', '2014·01·04')
  })
})

// Critique round 4, signature moment 4 and P2-15.
describe('ContactSheet live development', () => {
  it('a fresh frame becomes fixed once it has developed, so its filter and layer go away', () => {
    // Arrange
    stubLayout(1200, 800)
    const { container } = render(liveSheet())
    const cell = () => container.querySelector('[aria-label="photo 11"]')
    land(container, ...items.map((_, i) => i))
    expect(cell()).toHaveAttribute('data-film', 'fresh')

    // Act
    develop(container, ...items.map((_, i) => i))

    // Assert
    expect(cell()).toHaveAttribute('data-film', 'fixed')
    expect(cell()).toHaveClass('newest')
  })

  it('gives each latent frame a breathing delay locked to the document clock', () => {
    // Arrange
    stubLayout(1200, 800)

    // Act
    const { container } = render(liveSheet())

    // Assert
    const delays = items.map((_, i) => (container.querySelector(`[aria-label="photo ${i}"]`) as HTMLElement).style.getPropertyValue('--latent-delay'))
    expect(delays.every((d) => /^-?[\d.]+ms$/.test(d))).toBe(true)
    const ms = delays.map((d) => parseFloat(d))
    // Mounted in the same frame: neighbours are 160 ms apart on the 4.8 s breath.
    expect((((ms[3] ?? 0) - (ms[4] ?? 0)) % 4800 + 4800) % 4800).toBeCloseTo(4800 - 160, 0)
  })

  it('the library (not reading) sets no breathing delay', () => {
    stubLayout(1200, 800)
    const { container } = render(<ContactSheet items={items} base="/__mock/img/" ariaLabel="Photos" />)
    expect((container.querySelector('[aria-label="photo 0"]') as HTMLElement).style.getPropertyValue('--latent-delay')).toBe('')
  })

  it('glides after the newest row as frames are read, over several frames instead of jumping a row', () => {
    // Arrange: a 100 px view over one row; frames run by hand.
    stubLayout(1200, 100)
    let frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const frame = (t: number) => {
      const due = frames
      frames = []
      for (const cb of due) cb(t)
    }
    const sheetOf = (n: number) => <ContactSheet items={items.slice(0, n)} base="/__mock/img/" follow reading ariaLabel="Matched photos" />
    const { rerender } = render(sheetOf(10))
    const sheet = screen.getByLabelText('Matched photos')
    const start = sheet.scrollTop

    // Act: two more photos are read, starting row 2.
    rerender(sheetOf(12))
    act(() => frame(16))
    const first = sheet.scrollTop
    act(() => {
      for (let t = 32; t <= 800; t += 16) frame(t)
    })

    // Assert: 10 columns of 116.7 px make 114.5 px rows; row 2's strip ends at 220 px, 120 px below a 100 px view.
    expect(first).toBeGreaterThan(start)
    expect(first).toBeLessThan(110)
    expect(sheet.scrollTop).toBeCloseTo(120.05, 1)
  })

  // Integration (batch 13): when reading outran the pictures, the sheet followed the newest row and showed
  // only latent film, the developing edge rows above, out of view. It follows the edge, two latent rows ahead.
  it('keeps the developing edge in view when reading outruns the pictures by less than a screen', () => {
    // Arrange: a 300 px view (a screen of three rows, 30 frames); ten frames read, then twenty more before any picture lands.
    stubLayout(1200, 300)
    let frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100_000)
    const many: SheetItem[] = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, version: 'v1', dayKey: '2014-02-01', label: `frame ${i}` }))
    const sheetOf = (n: number) => <ContactSheet items={many.slice(0, n)} base="/__mock/img/" follow reading ariaLabel="Matched photos" />
    const { rerender, container } = render(sheetOf(10))
    const sheet = screen.getByLabelText('Matched photos')

    // Act
    rerender(sheetOf(30))
    act(() => {
      for (let t = 16; t <= 1600; t += 16) {
        const due = frames
        frames = []
        for (const cb of due) cb(t)
      }
    })

    // Assert: nothing was passed (frame 0 still holds the edge), and the view stays on the first rows:
    // row 2's strip ends 334.5 px down, at the foot of a 300 px view.
    expect(sheet.scrollTop).toBeCloseTo(34.55, 1)
    landFrame(container, 1)
    expect(container.querySelector('[aria-label="frame 1"]')).toHaveAttribute('data-film', 'latent')
  })

  // QA §14 P1-1: on the real library the sheet trailed "Read N" further all scan (500 frames by the end).
  it('when reading outruns the pictures by more than a screen, the edge moves up to a screen behind the count', () => {
    // Arrange: a 100 px view (a screen of one row); ten frames read, then ninety more before any picture lands.
    stubLayout(1200, 100)
    let frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100_000)
    const many: SheetItem[] = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, version: 'v1', dayKey: '2014-02-01', label: `frame ${i}` }))
    const sheetOf = (n: number) => <ContactSheet items={many.slice(0, n)} base="/__mock/img/" follow reading ariaLabel="Matched photos" />
    const { rerender, container } = render(sheetOf(10))
    const sheet = screen.getByLabelText('Matched photos')

    // Act
    rerender(sheetOf(100))
    act(() => {
      for (let t = 16; t <= 1600; t += 16) {
        const due = frames
        frames = []
        for (const cb of due) cb(t)
      }
    })
    act(() => {
      sheet.dispatchEvent(new Event('scroll'))
    })

    // Assert: the follow went with the edge, far enough for the rows past it to be mounted (row 4's strip
    // ends at the view's foot, 563.6 px down)…
    expect(sheet.scrollTop).toBeCloseTo(463.6, 0)
    // …where the newest screen's first frame develops as soon as it lands; the frames before it don't hold it.
    landFrame(container, 90)
    expect(container.querySelector('[aria-label="frame 90"]')).toHaveAttribute('data-film', 'fresh')
  })

  // QA §14 P1-1: the follow went with the outline, which waits on each batch's develops, so only the rows
  // just past it were mounted and asked for their pictures: the edge fell further behind all scan.
  it('a fast reader: the edge keeps within a screen of the count, and the frames still develop along it', () => {
    // Arrange: a 600 px view (a screen of 60 frames, about the real sheet's); 480 frames read 3 a frame
    // (190 a second, twice the real library's pace); a picture lands the frame after its row mounts, and a
    // develop ends only at its deadline (jsdom has no animations, so each runs 250 ms long).
    vi.useFakeTimers()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    stubLayout(1200, 600)
    let frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100_000)
    const many: SheetItem[] = Array.from({ length: 480 }, (_, i) => ({ id: `m${i}`, version: 'v1', dayKey: '2014-02-01', label: `frame ${i}` }))
    const sheetOf = (n: number) => <ContactSheet items={many.slice(0, n)} base="/__mock/img/" follow reading ariaLabel="Matched photos" />
    const { rerender, container } = render(sheetOf(3))
    const sheet = screen.getByLabelText('Matched photos')
    const landed = new WeakSet<Element>()
    const developed = new Set<number>()
    const indexOf = (cell: Element) => Number(cell.getAttribute('aria-label')?.slice(6))
    let worstGap = 0

    // Act
    for (let read = 3; read <= 480; read += 3) {
      rerender(sheetOf(read))
      act(() => {
        for (const img of container.querySelectorAll('.frame-cell img')) {
          if (landed.has(img)) continue
          landed.add(img)
          fireEvent.load(img)
        }
      })
      now += 16
      act(() => {
        vi.advanceTimersByTime(16)
        const due = frames
        frames = []
        for (const cb of due) cb(now)
        sheet.dispatchEvent(new Event('scroll'))
      })
      for (const cell of container.querySelectorAll('.frame-cell[data-film="fresh"]')) developed.add(indexOf(cell))
      const shown = [...container.querySelectorAll('.frame-cell[data-film="fresh"], .frame-cell[data-film="fixed"]')].map(indexOf)
      worstGap = Math.max(worstGap, read - (Math.max(-1, ...shown) + 1))
    }

    // Assert: the shown edge never trailed the count by more than a screen, and frames developed along it
    // (passed frames would only have appeared, never developed).
    expect(worstGap).toBeLessThanOrEqual(60)
    expect(developed.size).toBeGreaterThanOrEqual(456)
  })

  // UI review 6, M1: "Jump to newest" only re-pinned, so the follow went back to the developing edge
  // the user had scrolled away from, rows above the newest, and might never catch up.
  it('Jump to newest goes to the newest rows, and the frames above that screen don’t hold the edge', () => {
    // Arrange: a 100 px view; ten frames read, the user scrolls back, ninety more are read meanwhile.
    stubLayout(1200, 100)
    let frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100_000)
    const run = () =>
      act(() => {
        for (let t = 16; t <= 1600; t += 16) {
          const due = frames
          frames = []
          for (const cb of due) cb(t)
        }
      })
    const many: SheetItem[] = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, version: 'v1', dayKey: '2014-02-01', label: `frame ${i}` }))
    const sheetOf = (n: number) => <ContactSheet items={many.slice(0, n)} base="/__mock/img/" follow reading ariaLabel="Matched photos" />
    const { rerender, container } = render(sheetOf(10))
    const sheet = screen.getByLabelText('Matched photos')
    fireEvent.wheel(sheet, { deltaY: -120 })
    rerender(sheetOf(100))

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Jump to newest' }))
    run()
    act(() => {
      sheet.dispatchEvent(new Event('scroll'))
    })

    // Assert: the last row's strip ends at the view's foot (10 rows of 114.5 px under a 100 px view)…
    expect(sheet.scrollTop).toBeCloseTo(1036.05, 0)
    // …and the newest screen's first frame develops as soon as it lands: nothing above it is waited for.
    const cell = container.querySelector<HTMLElement>('.sheet-scroll .frame-cell[aria-label="frame 90"]') as HTMLElement
    act(() => {
      fireEvent.load(cell.querySelector('img') as HTMLImageElement)
    })
    expect(cell).toHaveAttribute('data-film', 'fresh')
  })

  it('a sheet opened mid-scan starts at the newest rows, and the frames above them don’t hold the edge', () => {
    // Arrange: 200 frames read before the sheet mounted, under a 300 px view.
    stubLayout(1200, 300)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100_000)
    const many: SheetItem[] = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, version: 'v1', dayKey: '2014-02-01', label: `frame ${i}` }))

    // Act
    const { container } = render(<ContactSheet items={many} base="/__mock/img/" follow reading ariaLabel="Matched photos" />)
    const sheet = screen.getByLabelText('Matched photos')
    act(() => {
      sheet.dispatchEvent(new Event('scroll'))
    })

    // Assert: at the end at once, no glide from the top (20 rows of 114.5 px: the last strip ends 2,281.5 px down, under a 300 px view).
    expect(sheet.scrollTop).toBeCloseTo(1981.5, 1)
    const first = container.querySelector<HTMLElement>('.sheet-scroll .frame-cell[aria-label^="frame"]')
    const index = Number(first?.getAttribute('aria-label')?.slice(6))
    expect(index).toBeGreaterThan(100)

    // Act: the newest screen's first frame lands; nothing before it is waited for.
    landFrame(container, 170)

    // Assert
    expect(container.querySelector('[aria-label="frame 170"]')).toHaveAttribute('data-film', 'fresh')
  })
})

// QA §12 item 21: the library sheet had one tab stop per photo.
describe('ContactSheet library keyboard: one tab stop, arrows move it', () => {
  const tabStops = (container: HTMLElement) => Array.from(container.querySelectorAll('.frame-cell[tabindex="0"]')).map((c) => c.getAttribute('aria-label'))

  it('is one tab stop: the first photo, or the selected one; the scroller itself takes none', () => {
    // Arrange
    stubLayout(1200, 800)
    const onSelect = vi.fn()

    // Act
    const { container, rerender } = render(<ContactSheet items={items} base="/__mock/img/" onSelect={onSelect} ariaLabel="Photos" />)

    // Assert
    expect(tabStops(container)).toEqual(['photo 0'])
    expect(container.querySelectorAll('.frame-cell[tabindex="-1"]')).toHaveLength(items.length - 1)
    expect(screen.getByRole('group', { name: 'Photos' })).not.toHaveAttribute('tabindex')

    rerender(<ContactSheet items={items} base="/__mock/img/" onSelect={onSelect} selectedId="p7" ariaLabel="Photos" />)
    expect(tabStops(container)).toEqual(['photo 7'])
  })

  it('arrows move by a photo and by a row, Home and End to the ends, and the focused photo keeps the tab stop', () => {
    // Arrange: 1200 px makes rows of 10.
    stubLayout(1200, 800)
    const { container } = render(<ContactSheet items={items} base="/__mock/img/" onSelect={vi.fn()} ariaLabel="Photos" />)
    const cell = (i: number) => container.querySelector(`[aria-label="photo ${i}"]`) as HTMLElement
    act(() => cell(0).focus())

    // Act + Assert
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(cell(1))
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(cell(11))
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' })
    expect(document.activeElement).toBe(cell(0))
    const end = fireEvent.keyDown(document.activeElement as Element, { key: 'End' })
    expect(document.activeElement).toBe(cell(11))
    expect(end).toBe(false)
    expect(tabStops(container)).toEqual(['photo 11'])
  })

  it('Enter and Space still select the focused photo', async () => {
    // Arrange
    stubLayout(1200, 800)
    const onSelect = vi.fn()
    const { container } = render(<ContactSheet items={items} base="/__mock/img/" onSelect={onSelect} ariaLabel="Photos" />)
    act(() => (container.querySelector('[aria-label="photo 2"]') as HTMLElement).focus())

    // Act
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard(' ')

    // Assert
    expect(onSelect.mock.calls.map(([it]) => (it as SheetItem).id)).toEqual(['p2', 'p2'])
  })

  it('keeps a tab stop on screen when the stop photo has scrolled out of the mounted rows', async () => {
    // Arrange: 200 photos in rows of 10 under a 300 px view.
    stubLayout(1200, 300)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100_000)
    const many: SheetItem[] = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, version: 'v1', dayKey: '2014-02-01', label: `frame ${i}` }))
    const { container } = render(<ContactSheet items={many} base="/__mock/img/" onSelect={vi.fn()} ariaLabel="Photos" />)
    const sheet = screen.getByRole('group', { name: 'Photos' })

    // Act: scroll far down, so row 0 (the stop) unmounts.
    act(() => {
      sheet.scrollTop = 1500
      sheet.dispatchEvent(new Event('scroll'))
    })

    // Assert
    await waitFor(() => expect(container.querySelector('[aria-label="frame 0"]')).toBeNull())
    const stops = Array.from(container.querySelectorAll<HTMLElement>('.frame-cell[tabindex="0"]'))
    expect(stops).toHaveLength(1)
    expect(Number(stops[0]?.dataset.index)).toBeGreaterThan(100)
  })

  it('focus follows into rows the virtualizer had not mounted yet', async () => {
    // Arrange: 200 photos in rows of 10 under a 300 px view; scrolling really moves the view
    // (jsdom has no layout: the virtualizer clamps to scrollHeight, which jsdom reports as 0).
    stubLayout(1200, 300)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100_000)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = options.top ?? this.scrollTop
        this.dispatchEvent(new Event('scroll'))
      },
    })
    const many: SheetItem[] = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, version: 'v1', dayKey: '2014-02-01', label: `frame ${i}` }))
    const { container } = render(<ContactSheet items={many} base="/__mock/img/" onSelect={vi.fn()} ariaLabel="Photos" />)
    expect(container.querySelector('[aria-label="frame 199"]')).toBeNull()
    act(() => (container.querySelector('[aria-label="frame 0"]') as HTMLElement).focus())

    // Act
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' })

    // Assert
    await waitFor(() => expect(document.activeElement).toHaveAttribute('aria-label', 'frame 199'))
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  })
})
