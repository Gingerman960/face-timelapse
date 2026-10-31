/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { stubLayout } from '../../test/layout'
import { dayRange, formatDayLong } from '../../lib/dates'
import { DecadeRibbon, type RibbonProps } from './DecadeRibbon'
import { dayRuns, loupeCentre, monthMarks, spanBox } from './ribbonModel'

/** A 2D context that records fills, so drawing code runs under jsdom. */
function fakeCanvas() {
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  return ctx
}

interface Fill {
  alpha: number
  style: string
  x: number
  y: number
  w: number
  h: number
}

interface Frame {
  fills: Fill[]
  strokes: Array<{ alpha: number; style: string }>
}

/**
 * Records each draw's fills (with alpha and style) and hatch strokes; token
 * names stand in for colours. A draw starts with clearRect, and the canvas
 * height tells the focus row (34) from the decade row (18). `focus` and
 * `all` read the latest draw of each canvas (both draw again once measured).
 */
function recordDrawing() {
  const ctx = fakeCanvas()
  const latest = new Map<number, Frame>()
  let current: Frame = { fills: [], strokes: [] }
  ctx.clearRect.mockImplementation((_x: number, _y: number, _w: number, h: number) => {
    current = { fills: [], strokes: [] }
    latest.set(h, current)
  })
  ctx.fillRect.mockImplementation((x: number, y: number, w: number, h: number) => current.fills.push({ alpha: ctx.globalAlpha, style: ctx.fillStyle, x, y, w, h }))
  ctx.stroke.mockImplementation(() => current.strokes.push({ alpha: ctx.globalAlpha, style: ctx.strokeStyle }))
  vi.spyOn(CSSStyleDeclaration.prototype, 'getPropertyValue').mockImplementation(
    (name: string) =>
      ({
        '--text-1': 'ink',
        '--text-2': 'loud',
        '--ribbon-day': 'day',
        '--ribbon-month': 'month',
        '--line': 'off',
        '--mark': 'mark',
        '--ribbon-fill': 'fill',
      })[name] ?? '',
  )
  const focus = (): Frame => latest.get(34) ?? { fills: [], strokes: [] }
  const all = (): Fill[] => [...latest.values()].flatMap((f) => f.fills)
  return { ctx, focus, all }
}

const PRESENT = new Set(['2014-01-01', '2014-01-02', '2014-03-10', '2015-06-01', '2020-12-31'])

function renderRibbon(overrides: Partial<RibbonProps> = {}) {
  const onSeek = vi.fn<(day: string) => void>()
  const props: RibbonProps = {
    start: '2012-01-01',
    end: '2022-12-31',
    present: PRESENT,
    focusYear: 2014,
    cursor: '2014-03-10',
    onSeek,
    label: 'Ten years of days',
    ...overrides,
  }
  const view = render(<DecadeRibbon {...props} />)
  return { ...view, props, onSeek }
}

describe('DecadeRibbon', () => {
  it('labels the focus year and the years of the decade', () => {
    // Act
    const { container } = renderRibbon()

    // Assert
    expect(screen.getByRole('contentinfo', { name: 'Ten years of days' })).toBeInTheDocument()
    expect(container.querySelector('.ribbon-label')).toHaveTextContent('2014')
    const years = Array.from(container.querySelectorAll('.ribbon-years span')).map((s) => s.textContent)
    expect(years).toEqual(['2012', '2013', '2014', '2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022'])
  })

  it('PageUp/PageDown move a month and ⌥ arrows a year on the hidden slider', () => {
    // Arrange
    const { onSeek } = renderRibbon()
    const slider = screen.getByRole('slider', { name: 'Ten years of days' })
    expect(slider).toHaveAttribute('aria-valuetext', formatDayLong('2014-03-10'))

    // Act
    fireEvent.keyDown(slider, { key: 'PageDown' })
    fireEvent.keyDown(slider, { key: 'PageUp' })
    fireEvent.keyDown(slider, { key: 'ArrowRight', altKey: true })
    fireEvent.keyDown(slider, { key: 'ArrowLeft', altKey: true })
    const plain = fireEvent.keyDown(slider, { key: 'ArrowLeft' })

    // Assert
    expect(onSeek.mock.calls.map((c) => c[0])).toEqual(['2014-04-09', '2014-02-08', '2015-03-10', '2013-03-10'])
    expect(plain).toBe(true)
  })

  it('clamps keyboard jumps to the decade', () => {
    // Arrange
    const { onSeek } = renderRibbon({ cursor: '2012-01-10' })
    const slider = screen.getByRole('slider')

    // Act
    fireEvent.keyDown(slider, { key: 'ArrowLeft', altKey: true })

    // Assert
    expect(onSeek).toHaveBeenCalledWith('2012-01-01')
  })

  it('the slider value seeks directly', () => {
    // Arrange
    const { onSeek } = renderRibbon()

    // Act
    fireEvent.change(screen.getByRole('slider'), { target: { value: '366' } })

    // Assert
    expect(onSeek).toHaveBeenCalledWith('2013-01-01')
  })

  it('keys do nothing without a cursor', () => {
    // Arrange
    const { onSeek } = renderRibbon({ cursor: null })

    // Act
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'PageDown' })

    // Assert
    expect(onSeek).not.toHaveBeenCalled()
    expect(screen.getByRole('slider')).toHaveValue('0')
  })

  it('is read-only without onSeek', () => {
    // Act
    const { container } = renderRibbon({ onSeek: undefined })
    fireEvent.pointerDown(container.querySelector('.ribbon-track') as HTMLElement, { clientX: 10 })

    // Assert
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('pointer down on the focus year seeks that day, and a captured drag keeps seeking', () => {
    // Arrange
    stubLayout(365, 34)
    const { container, onSeek } = renderRibbon()
    const [focus] = Array.from(container.querySelectorAll<HTMLElement>('.ribbon-track'))

    // Act
    fireEvent.pointerDown(focus as HTMLElement, { pointerId: 1, clientX: 31.5 })
    vi.spyOn(Element.prototype, 'hasPointerCapture').mockReturnValue(true)
    fireEvent.pointerMove(focus as HTMLElement, { pointerId: 1, clientX: 59.5 })

    // Assert
    expect(onSeek.mock.calls.map((c) => c[0])).toEqual(['2014-02-01', '2014-03-01'])
  })

  it('pointer down on the decade track seeks across the whole span', () => {
    // Arrange
    stubLayout(4018, 18)
    const { container, onSeek } = renderRibbon()
    const decade = container.querySelectorAll<HTMLElement>('.ribbon-track')[1] as HTMLElement

    // Act
    fireEvent.pointerDown(decade, { pointerId: 1, clientX: -50 })
    fireEvent.pointerDown(decade, { pointerId: 1, clientX: 2009 })

    // Assert
    expect(onSeek.mock.calls.map((c) => c[0])).toEqual(['2012-01-01', '2017-07-02'])
  })

  // Regression: f = 1 at the right edge used to seek one day past the end.
  it('pointer down at the right edge seeks the last day, not the day after', () => {
    stubLayout(4018, 18)
    const { container, onSeek } = renderRibbon()
    const decade = container.querySelectorAll<HTMLElement>('.ribbon-track')[1] as HTMLElement
    fireEvent.pointerDown(decade, { pointerId: 1, clientX: 99999 })
    expect(onSeek).toHaveBeenLastCalledWith('2022-12-31')
  })

  it('hovering the focus year shows a loupe for that day, and leaving hides it', () => {
    // Arrange
    stubLayout(365, 34)
    const loupeUrl = vi.fn((day: string) => (day === '2014-01-02' ? `/thumb/${day}` : null))
    const { container, onSeek } = renderRibbon({ loupeUrl })
    const focus = container.querySelector('.ribbon-track') as HTMLElement

    // Act + Assert
    fireEvent.pointerMove(focus, { pointerId: 1, clientX: 1.5 })
    expect(container.querySelector('.ribbon-loupe img')).toHaveAttribute('src', '/thumb/2014-01-02')
    // Critique P1-6: a date in words, not the raw day key.
    expect(container.querySelector('.ribbon-loupe')).toHaveTextContent('Thu 2 Jan 2014')
    expect(container.querySelector('.ribbon-loupe')).not.toHaveTextContent('2014-01-02')
    expect(onSeek).not.toHaveBeenCalled()

    fireEvent.pointerMove(focus, { pointerId: 1, clientX: 100 })
    expect(container.querySelector('.ribbon-loupe')).toBeNull()

    fireEvent.pointerMove(focus, { pointerId: 1, clientX: 1.5 })
    fireEvent.pointerLeave(focus)
    expect(container.querySelector('.ribbon-loupe')).toBeNull()
  })

  it('draws present days as a baseline broken where a day has no photo, with twelve month ticks', () => {
    // Arrange
    stubLayout(365, 34)
    const { focus } = recordDrawing()

    // Act: 2014 has photos on 1–2 Jan and 10 Mar.
    renderRibbon()
    const { fills } = focus()

    // Assert: one baseline segment per run of days, 1 px tall, in the quiet day zone.
    const baseline = fills.filter((f) => f.style === 'day')
    expect(baseline).toHaveLength(2)
    expect(baseline.every((f) => f.h === 1 && f.y === baseline[0]?.y)).toBe(true)
    expect(baseline[0]?.x).toBe(0)
    expect(baseline[0]?.w).toBe(2)
    expect(baseline[1]?.x).toBe(68)
    // Month ticks: 8 px, at each month's first day.
    const months = fills.filter((f) => f.style === 'month')
    expect(months.map((f) => f.x)).toEqual([0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334])
    expect(months.every((f) => f.h === 8)).toBe(true)
    // The ticks stand on the baseline.
    expect((months[0]?.y ?? 0) + 8).toBe(baseline[0]?.y)
  })

  it('marks your picks with chinagraph dashes and hatches left-out days, never both', () => {
    // Arrange
    stubLayout(365, 34)
    const { focus } = recordDrawing()

    // Act: a pick on 1 Jan; 2 Jan is left out and was picked by hand too.
    renderRibbon({ mine: new Set(['2014-01-01', '2014-01-02']), excluded: new Set(['2014-01-02']) })
    const { fills, strokes } = focus()

    // Assert
    const dashes = fills.filter((f) => f.style === 'mark')
    expect(dashes).toHaveLength(1)
    expect(dashes[0]?.x).toBeLessThan(1)
    expect(dashes[0]?.h).toBeGreaterThanOrEqual(5)
    // Picks and the hatch hang under the baseline (the cell's "your pick" underline).
    const baselineY = fills.find((f) => f.style === 'day')?.y ?? 0
    expect(dashes[0]?.y).toBeGreaterThan(baselineY)
    // The hatch: text-2 at 60 %, as on the Days cells.
    expect(strokes).toEqual([{ alpha: 0.6, style: 'loud' }])
  })

  it('keeps the unexposed stretch faint while scanning, and never uses text ink for days', () => {
    // Arrange
    stubLayout(400, 34)
    const { ctx, all } = recordDrawing()

    // Act
    renderRibbon({ exposedUntil: '2014-03-31' })
    const fills = all()

    // Assert
    expect(ctx.setTransform).toHaveBeenCalled()
    expect(ctx.strokeRect).toHaveBeenCalled()
    // Quiet zones only (critique P2-9 and round 2): ink is for the cursor and the bracket.
    expect(new Set(fills.map((f) => f.style))).toEqual(new Set(['day', 'month', 'off', 'fill']))
    // The not-yet-exposed stretch of baseline and decade are dimmed.
    expect(fills.some((f) => f.style === 'off' && f.alpha === 0.5 && f.h === 1)).toBe(true)
    expect(fills.some((f) => f.alpha === 0.18)).toBe(true)
  })

  it('letters the months in edge print beside their ticks', () => {
    // Act
    const { container } = renderRibbon({ focusYear: 2016 })

    // Assert
    const letters = Array.from(container.querySelectorAll<HTMLElement>('.ribbon-months span'))
    expect(letters.map((l) => l.textContent).join('')).toBe('JFMAMJJASOND')
    expect(container.querySelector('.ribbon-months')).toHaveAttribute('aria-hidden', 'true')
    expect(parseFloat(letters[2]?.style.left ?? '')).toBeCloseTo((60 / 366) * 100, 3)
  })

  // N3 (WebKit memory): assigning a canvas's size reallocates its backing store even when unchanged.
  it('keeps the canvas backing stores when a redraw has the same size', () => {
    // Arrange
    stubLayout(400, 34)
    const ctx = fakeCanvas()
    const sizes = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width') as PropertyDescriptor
    const setWidth = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set').mockImplementation(function (this: HTMLCanvasElement, v: number) {
      setWidth(v)
      sizes.set?.call(this, v)
    })
    const { rerender, props } = renderRibbon()
    const allocations = setWidth.mock.calls.length
    const draws = ctx.fillRect.mock.calls.length

    // Act: new data, same size.
    rerender(<DecadeRibbon {...props} present={new Set([...PRESENT, '2014-06-06'])} />)

    // Assert
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(draws)
    expect(setWidth.mock.calls.length).toBe(allocations)
  })

  it('places the cursor on both tracks and hides the focus cursor outside the focus year', () => {
    // Arrange
    stubLayout(400, 34)

    // Act
    const { container, rerender, props } = renderRibbon()
    const both = container.querySelectorAll('.ribbon-cursor').length
    rerender(<DecadeRibbon {...props} cursor="2019-05-05" />)

    // Assert
    expect(both).toBe(2)
    expect(container.querySelectorAll('.ribbon-cursor')).toHaveLength(1)
  })
})

describe('DecadeRibbon: critique P2-9 and P1-3', () => {
  it('labels every year, the first one too, centred in its span', () => {
    const { container } = renderRibbon({ start: '2012-09-01', end: '2022-08-31' })
    const spans = Array.from(container.querySelectorAll<HTMLElement>('.ribbon-years span'))
    expect(spans.map((s) => s.textContent)).toEqual(['2012', '2013', '2014', '2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022'])
    // 2013 is a whole year: centred halfway through it.
    const total = 3652
    const mid2013 = (122 + 365 / 2) / total
    expect(parseFloat(spans[1]?.style.left ?? '')).toBeCloseTo(mid2013 * 100, 1)
    // 2012 covers only Sep–Dec: centred in that part.
    expect(parseFloat(spans[0]?.style.left ?? '')).toBeCloseTo((122 / 2 / total) * 100, 1)
  })

  it('marks the part of the focus year the calendar shows', () => {
    const { container } = renderRibbon({ focusYear: 2014, visibleSpan: { start: '2014-03-01', end: '2014-03-31' } })
    const span = container.querySelector<HTMLElement>('.ribbon-visible')
    expect(span).not.toBeNull()
    expect(parseFloat(span?.style.left ?? '')).toBeCloseTo((59 / 365) * 100, 1)
    expect(parseFloat(span?.style.width ?? '')).toBeCloseTo((31 / 365) * 100, 1)
  })

  it('hides the span rule when the calendar shows the whole year', () => {
    const { container } = renderRibbon({ focusYear: 2014, visibleSpan: { start: '2014-01-01', end: '2014-12-31' } })
    expect(container.querySelector('.ribbon-visible')).toBeNull()
  })

  it('keeps the 160 px loupe over the track near its ends', () => {
    stubLayout(365, 34)
    const { container } = renderRibbon({ loupeUrl: () => '/thumb/x' })
    fireEvent.pointerMove(container.querySelector('.ribbon-track') as HTMLElement, { pointerId: 1, clientX: 1.5 })
    const loupe = container.querySelector<HTMLElement>('.ribbon-loupe')
    expect(parseFloat(loupe?.style.left ?? '')).toBeGreaterThanOrEqual(80)
  })

  it('clips the visible span to the focus year and draws nothing without one', () => {
    const { container, rerender, props } = renderRibbon({ focusYear: 2014, visibleSpan: { start: '2013-12-01', end: '2014-01-31' } })
    const span = container.querySelector<HTMLElement>('.ribbon-visible')
    expect(parseFloat(span?.style.left ?? '')).toBeCloseTo(0, 3)
    expect(parseFloat(span?.style.width ?? '')).toBeCloseTo((31 / 365) * 100, 1)
    rerender(<DecadeRibbon {...props} visibleSpan={null} />)
    expect(container.querySelector('.ribbon-visible')).toBeNull()
  })
})

describe('DecadeRibbon memory (HIGH-3)', () => {
  it('gives its canvases back on unmount', () => {
    stubLayout(400, 34)
    const { container, unmount } = renderRibbon()
    const canvases = Array.from(container.querySelectorAll('canvas'))
    unmount()
    expect(canvases.map((c) => [c.width, c.height])).toEqual([
      [0, 0],
      [0, 0],
    ])
  })
})

// Critique round 4, P1-6: the pure geometry of the focus row.
describe('monthMarks', () => {
  it('puts a tick on the first day of each month, lettered J F M … D', () => {
    // Act
    const marks = monthMarks(2014)

    // Assert
    expect(marks.map((m) => m.letter).join('')).toBe('JFMAMJJASOND')
    expect(marks.map((m) => m.offset)).toEqual([0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334])
    expect(marks[7]?.fraction).toBeCloseTo(212 / 365, 6)
  })

  it('counts the leap day', () => {
    const marks = monthMarks(2016)
    expect(marks[2]?.offset).toBe(60)
    expect(marks[11]?.fraction).toBeCloseTo(335 / 366, 6)
  })
})

describe('dayRuns', () => {
  const keys = dayRange('2014-01-01', 10)

  it('groups consecutive days that pass into [start, end) runs', () => {
    // Arrange
    const present = new Set(['2014-01-01', '2014-01-02', '2014-01-03', '2014-01-05', '2014-01-08', '2014-01-09', '2014-01-10'])

    // Act
    const runs = dayRuns(keys, (k) => present.has(k))

    // Assert
    expect(runs).toEqual([
      [0, 3],
      [4, 5],
      [7, 10],
    ])
  })

  it('is empty when no day passes, and one run when every day does', () => {
    expect(dayRuns(keys, () => false)).toEqual([])
    expect(dayRuns(keys, () => true)).toEqual([[0, 10]])
  })
})

describe('spanBox: the part of the focus year the calendar shows', () => {
  it('marks a month as a share of the year', () => {
    const box = spanBox({ start: '2014-03-01', end: '2014-03-31' }, 2014)
    expect(box?.left).toBeCloseTo(59 / 365, 6)
    expect(box?.width).toBeCloseTo(31 / 365, 6)
  })

  it('clips a span that starts in the year before', () => {
    const box = spanBox({ start: '2013-12-01', end: '2014-01-31' }, 2014)
    expect(box?.left).toBe(0)
    expect(box?.width).toBeCloseTo(31 / 365, 6)
  })

  it('draws nothing when the span covers the whole year (a rule under every day says nothing)', () => {
    expect(spanBox({ start: '2014-01-01', end: '2014-12-31' }, 2014)).toBeNull()
    expect(spanBox({ start: '2013-06-01', end: '2015-02-01' }, 2014)).toBeNull()
  })

  it('draws nothing outside the focus year or without a span', () => {
    expect(spanBox({ start: '2015-01-01', end: '2015-03-01' }, 2014)).toBeNull()
    expect(spanBox(null, 2014)).toBeNull()
    expect(spanBox(undefined, 2014)).toBeNull()
  })
})

describe('loupeCentre', () => {
  it('follows the pointer, but keeps the whole loupe over the track', () => {
    expect(loupeCentre(400, 800, 84)).toBe(400)
    expect(loupeCentre(10, 800, 84)).toBe(84)
    expect(loupeCentre(795, 800, 84)).toBe(716)
  })

  it('centres on a track narrower than the loupe', () => {
    expect(loupeCentre(20, 120, 84)).toBe(60)
  })
})

// Critique round 5, P2-9: photos are read in no order of date, so "exposed until the last day read"
// flickered across the decade. While scanning, each day is exposed in its year as it's found.
describe('DecadeRibbon: exposure in read order', () => {
  it('exposes exactly the days read, wherever they fall, and keeps every other day faint', () => {
    // Arrange: one decade column per day; 2014 at 11 px a day on the focus row.
    stubLayout(4018, 34)
    const { focus, all } = recordDrawing()
    const read = new Set(['2014-01-01', '2014-03-10', '2020-12-31'])

    // Act
    renderRibbon({ present: read, exposedDays: read })

    // Assert: the focus row's baseline under the two days read in 2014, faint line between and after them.
    const fills = focus().fills
    expect(fills.filter((f) => f.style === 'day').map((f) => f.x)).toEqual([0, 748.5])
    const faint = fills.filter((f) => f.style === 'off' && f.h === 1)
    expect(faint).toHaveLength(2)
    expect(faint.every((f) => f.alpha === 0.5)).toBe(true)
    // The decade: a column per day; read days lit, the days around them unexposed.
    const column = (x: number) => all().find((f) => f.h === 10 && f.x === x)
    expect(column(731)).toMatchObject({ style: 'fill', alpha: 1 })
    expect(column(730)).toMatchObject({ style: 'off', alpha: 0.18 })
    expect(column(3287)).toMatchObject({ style: 'fill', alpha: 1 })
  })

  it('an empty set exposes nothing yet', () => {
    stubLayout(4018, 34)
    const { focus } = recordDrawing()
    renderRibbon({ present: new Set(), exposedDays: new Set() })
    const fills = focus().fills
    expect(fills.filter((f) => f.style === 'day')).toEqual([])
    expect(fills.filter((f) => f.style === 'off' && f.h === 1)).toHaveLength(1)
  })
})

// Critique round 5, P3-27: the canvas reads the ribbon tokens when it draws, so a change to
// "Increase contrast" has to redraw it.
describe('DecadeRibbon: increased contrast', () => {
  it('redraws both canvases when prefers-contrast changes', () => {
    // Arrange
    stubLayout(400, 34)
    const listeners: Array<() => void> = []
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: (_: string, cb: () => void) => {
            if (query === '(prefers-contrast: more)') listeners.push(cb)
          },
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    )
    const ctx = fakeCanvas()
    renderRibbon()
    const draws = ctx.clearRect.mock.calls.length

    // Act
    act(() => {
      for (const cb of listeners) cb()
    })

    // Assert
    expect(listeners.length).toBeGreaterThan(0)
    expect(ctx.clearRect.mock.calls.length).toBe(draws + 2)
  })
})

/** ribbon.css without comments: Vitest hands CSS imports over empty, so the rules are read from disk. */
function ribbonCss(): string {
  return readFileSync(join(process.cwd(), 'src', 'features', 'shell', 'ribbon.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

interface CssRule {
  media: string | null
  selector: string
  body: string
}

/** Rules, with the @media they sit in (one level, as ribbon.css writes them). */
function cssRules(css: string, media: string | null = null): CssRule[] {
  const out: CssRule[] = []
  let pos = 0
  while (pos < css.length) {
    const open = css.indexOf('{', pos)
    if (open < 0) break
    let depth = 1
    let end = open + 1
    while (depth > 0 && end < css.length) {
      if (css[end] === '{') depth++
      else if (css[end] === '}') depth--
      end++
    }
    const head = css.slice(pos, open).trim()
    const body = css.slice(open + 1, end - 1)
    if (head.startsWith('@media')) out.push(...cssRules(body, head.slice('@media'.length).trim()))
    else out.push({ media, selector: head.replace(/\s+/g, ' '), body })
    pos = end
  }
  return out
}

function declaration(rule: CssRule | undefined, prop: string): string | undefined {
  return rule ? new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(rule.body)?.[1]?.trim() : undefined
}

describe('ribbon.css', () => {
  const rules = cssRules(ribbonCss())
  const rule = (selector: string, media: string | null = null) => rules.find((r) => r.selector === selector && r.media === media)

  // Critique round 5, P2-14: at 1440 the 2 px span rule read as a progress bar, the loudest mark.
  it('marks the span on screen with two 6 px crop-mark feet, never a bar', () => {
    const span = rule('.ribbon-visible')
    expect(declaration(span, 'background')).toBeUndefined()
    const feet = rule('.ribbon-visible::before, .ribbon-visible::after')
    expect(declaration(feet, 'width')).toBe('6px')
    expect(declaration(feet, 'height')).toBe('6px')
    expect(declaration(feet, 'border')).toContain('var(--ribbon-span)')
    expect(declaration(rule('.ribbon-visible::before'), 'border-left-width')).toBe('1px')
    expect(declaration(rule('.ribbon-visible::after'), 'border-right-width')).toBe('1px')
  })

  // Critique round 5, P3-23: will-change only while something moves.
  it('keeps no permanent will-change on the cursor', () => {
    expect(rule('.ribbon-cursor')).toBeDefined()
    expect(declaration(rule('.ribbon-cursor'), 'will-change')).toBeUndefined()
  })
})

// Critique round 5, P3-27: the baseline told photo from no photo at about 2:1, and didn't step up
// under "Increase contrast". Contrast is computed from the tokens, as DESIGN's table is.
describe('ribbon tokens: contrast against the canvas', () => {
  /** The Zone ramp from tokens.css: --z0 … --z10 as OKLCH lightness, chroma, hue. */
  function zones(): Map<string, [number, number, number]> {
    const tokens = readFileSync(join(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8')
    return new Map([...tokens.matchAll(/--(z\d+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g)].map((m) => [m[1] as string, [Number(m[2]) / 100, Number(m[3]), Number(m[4])]]))
  }

  /** WCAG relative luminance of an OKLCH colour (via linear sRGB, clipped). */
  function luminance([L, C, h]: [number, number, number]): number {
    const a = C * Math.cos((h * Math.PI) / 180)
    const b = C * Math.sin((h * Math.PI) / 180)
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
    const clip = (v: number) => Math.min(1, Math.max(0, v))
    const r = clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
    const g = clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
    const bl = clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }

  const z = zones()
  const contrast = (token: string | undefined, canvas: string) => {
    const fg = z.get(/var\(--(z\d+)\)/.exec(token ?? '')?.[1] ?? '')
    const bg = z.get(canvas)
    if (!fg || !bg) return 0
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((p, q) => q - p) as [number, number]
    return (hi + 0.05) / (lo + 0.05)
  }

  const rules = cssRules(ribbonCss())
  const at = (media: string | null, test: (selector: string) => boolean) => rules.find((r) => r.media === media && test(r.selector))
  const MORE = '(prefers-contrast: more)'
  const modes = {
    dark: at(null, (s) => s.includes(':root[data-theme="dark"]')),
    light: at(null, (s) => s === ':root[data-theme="light"]'),
    systemLight: at('(prefers-color-scheme: light)', (s) => s === ':root:not([data-theme="dark"])'),
    darkMore: at(MORE, (s) => s.includes(':root[data-theme="dark"]')),
    lightMore: at(MORE, (s) => s === ':root[data-theme="light"]'),
    systemLightMore: at(`${MORE} and (prefers-color-scheme: light)`, (s) => s === ':root:not([data-theme="dark"])'),
  }
  const canvas = { dark: 'z0', light: 'z10', systemLight: 'z10', darkMore: 'z0', lightMore: 'z10', systemLightMore: 'z10' } as const

  it('sets the ribbon tokens in all four theme modes, with and without increased contrast', () => {
    for (const [mode, r] of Object.entries(modes)) {
      expect(r, mode).toBeDefined()
      expect(declaration(r, '--ribbon-day'), mode).toMatch(/^var\(--z\d+\)$/)
    }
    expect(declaration(modes.systemLight, '--ribbon-day')).toBe(declaration(modes.light, '--ribbon-day'))
    expect(declaration(modes.systemLightMore, '--ribbon-day')).toBe(declaration(modes.lightMore, '--ribbon-day'))
  })

  it('draws the baseline at 3:1 or more against the canvas in both themes', () => {
    for (const mode of ['dark', 'light', 'systemLight'] as const) {
      expect(contrast(declaration(modes[mode], '--ribbon-day'), canvas[mode]), mode).toBeGreaterThanOrEqual(3)
    }
  })

  it('steps the baseline, the month ticks and the span feet up under increased contrast', () => {
    for (const [base, more] of [['dark', 'darkMore'], ['light', 'lightMore'], ['systemLight', 'systemLightMore']] as const) {
      for (const token of ['--ribbon-day', '--ribbon-month', '--ribbon-span']) {
        expect(contrast(declaration(modes[more], token), canvas[more]), `${more} ${token}`).toBeGreaterThan(contrast(declaration(modes[base], token), canvas[base]))
      }
    }
  })

  it('keeps the month ticks a step louder than the baseline, and the span feet at 3:1', () => {
    for (const mode of Object.keys(modes) as Array<keyof typeof modes>) {
      const day = contrast(declaration(modes[mode], '--ribbon-day'), canvas[mode])
      expect(contrast(declaration(modes[mode], '--ribbon-month'), canvas[mode]), mode).toBeGreaterThan(day)
      expect(contrast(declaration(modes[mode], '--ribbon-span'), canvas[mode]), mode).toBeGreaterThanOrEqual(3)
    }
  })
})
