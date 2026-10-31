import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { PhotoId } from '../../ipc/contract'
import { thumbUrl } from '../../ipc/images'
import { QuietButton } from '../../components/ui/Button'
import { useDampedFollow } from './dampedFollow'
import { createFrontier } from './frontier'
import { followTarget, rovingTarget, rowMonthPrint } from './scanModel'
import { SheetCell, type SheetItem } from './SheetCell'

export type { SheetItem } from './SheetCell'

interface ContactSheetProps {
  items: readonly SheetItem[]
  base: string
  /** Keep the newest row in view (live scan) until the user scrolls up. */
  follow?: boolean
  /**
   * Live scan: frames develop in order along one leading edge as their images
   * land (frontier.ts), the newest developed frame is outlined, rows print
   * frame numbers only (they're in read order, not date order), and the last
   * strip fills with unexposed slots.
   */
  reading?: boolean
  selectedId?: PhotoId | null
  onSelect?: (item: SheetItem) => void
  empty?: ReactNode
  ariaLabel: string
  /** Library: told which items are on screen when the visible rows change, so the ribbon can follow the scroll. */
  onVisibleItems?: (first: number, last: number) => void
  /** Library: an item to bring to the top (a ribbon seek); a new object repeats a seek to the same item. */
  seek?: { index: number } | null
}

const GAP = 3
/** Below this cell width the edge print keeps only the frame number, and a row's month on its first frame (critique P2-14, round 4 P2-15). */
const EDGE_DATE_MIN_PX = 150
const REBATE_TOP = 15
const STRIP_PAD = 3
const STRIP_MARGIN = 9
/** Live scan: rows of the latent run kept in view under the developing edge. */
const LATENT_ROWS_AHEAD = 2
/**
 * Live scan: rows mounted past the view, so pictures are asked for ahead of the edge while the
 * view stays on the developing rows. With the usual 2 the edge waited on rows that mounted only
 * once the outline reached them (QA §14 P1-1).
 */
const READING_OVERSCAN = 6
/** Live scan: rows past the release edge whose pictures are always on their way. */
const PREFETCH_ROWS = 2
/** Keys that scroll back toward older rows: following the newest stops. */
const BACK_KEYS = ['ArrowUp', 'PageUp', 'Home']

function columnsFor(width: number): number {
  return Math.max(5, Math.min(14, Math.floor(width / 112)))
}

/** How many frames one screen of rows holds. */
function framesOnScreen(scroller: HTMLElement | null, cols: number, rowH: number): number {
  return cols * Math.max(1, Math.ceil((scroller?.clientHeight ?? rowH) / rowH))
}

/** The scroller's inner width and vertical padding (the strips sit inside the padding). */
interface Box {
  width: number
  padTop: number
  padBottom: number
}

function useBox(scroller: React.RefObject<HTMLDivElement | null>): Box {
  const [box, setBox] = useState<Box>({ width: 0, padTop: 0, padBottom: 0 })
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const cs = getComputedStyle(el)
      const px = (v: string) => parseFloat(v || '0') || 0
      setBox({ width: el.clientWidth - 2 * px(cs.paddingLeft), padTop: px(cs.paddingTop), padBottom: px(cs.paddingBottom) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [scroller])
  return box
}

/**
 * A virtualized contact sheet: rows are film strips with edge print.
 *
 * Live scan (`follow`, `reading`): frames breathe as one wave while latent and
 * develop in order along one leading edge; the sheet glides after the newest
 * row on a damped spring until the user scrolls back, so the developed rows,
 * the edge and the latent run before it are all in view. Library (`onSelect`):
 * one tab stop, with arrow keys, Home and End moving the focus through the
 * virtualized rows.
 */
export function ContactSheet({ items, base, follow, reading, selectedId, onSelect, empty, ariaLabel, onVisibleItems, seek }: ContactSheetProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const box = useBox(scroller)
  const [pinned, setPinned] = useState(true)
  // Live scan: the developing frontier; each cell subscribes to its own film, so the sheet
  // itself doesn't re-render as frames land and develop.
  const [frontier] = useState(createFrontier)
  useEffect(() => () => frontier.dispose(), [frontier])
  const cols = columnsFor(box.width || 900)
  // The developing edge's row (the outlined frame's) and the release edge's (its newest released frame's),
  // re-read only when they move to another row. The follow keeps the outline in view, two latent rows under
  // it, and never so far behind the release edge that the rows just past it aren't mounted (QA §14 P1-1):
  // the outline waits on each batch's develops, and following it alone kept only the rows just past it
  // mounted, so pictures were asked for late and on the real library the sheet fell further behind
  // "Read N" all scan (500 frames by the end).
  const outlineRow = useSyncExternalStore(frontier.subscribe, () => Math.floor(frontier.outline() / cols))
  const edgeRow = useSyncExternalStore(frontier.subscribe, () => Math.floor((frontier.edge() - 1) / cols))
  const cellW = Math.max(40, (box.width - 2 * STRIP_PAD - (cols - 1) * GAP) / cols)
  const rowH = REBATE_TOP + STRIP_PAD + (cellW * 3) / 4 + STRIP_MARGIN
  useEffect(() => {
    if (!reading) return
    frontier.read(items.length)
    // While following, frames more than a screen behind the count stop holding the edge (they appear as
    // their pictures land), so the edge never trails "Read N" by more than a screen.
    if (pinned && box.width > 0) frontier.pass(items.length - framesOnScreen(scroller.current, cols, rowH))
  }, [reading, items.length, frontier, pinned, box.width, cols, rowH])
  const slots = items.length
  const rows = Math.max(0, Math.ceil(slots / cols))
  const virtual = useVirtualizer({ count: rows, getScrollElement: () => scroller.current, estimateSize: () => rowH, overscan: reading ? READING_OVERSCAN : 2 })
  useEffect(() => virtual.measure(), [rowH, virtual])

  // The rows on screen (without overscan); the virtualizer re-renders on scroll, so this follows it.
  const firstRow = virtual.range?.startIndex ?? 0
  const lastRow = virtual.range?.endIndex ?? 0
  useEffect(() => {
    if (onVisibleItems && slots > 0) onVisibleItems(firstRow * cols, Math.min(slots - 1, (lastRow + 1) * cols - 1))
  }, [onVisibleItems, firstRow, lastRow, cols, slots])
  useEffect(() => {
    if (seek && rows > 0) virtual.scrollToIndex(Math.min(rows - 1, Math.floor(seek.index / cols)), { align: 'start' })
  }, [seek, cols, rows, virtual])

  // Live scan: glide after the newest row (critique round 4, P2-15: it jumped a row ~4×/s). A
  // sheet opened mid-scan starts there at once rather than gliding down from the top.
  const onScrollBack = useCallback(() => setPinned(false), [])
  // "Jump to newest" lands on the newest rows (UI review 6, M1): the frames above that screen stop
  // holding the edge, and the follow never goes back above the row it landed on.
  const floorRow = useRef(0)
  const jumpToNewest = () => {
    if (reading) frontier.pass(Math.max(0, items.length - framesOnScreen(scroller.current, cols, rowH)))
    floorRow.current = Math.max(0, rows - 1)
    setPinned(true)
  }
  const follower = useDampedFollow(scroller, onScrollBack)
  const primed = useRef(false)
  useEffect(() => {
    const el = scroller.current
    if (!follow || !pinned || rows === 0 || !el || box.width === 0) return
    const geometry = { rowH, gap: STRIP_MARGIN, padTop: box.padTop, padBottom: box.padBottom, viewport: el.clientHeight, total: rows * rowH }
    if (primed.current) {
      // The edge stays in view, the latent run ahead of it under it (and the rows past it mounted, so
      // their pictures are on their way): when reading outruns the pictures the newest rows are all
      // latent film, so the sheet follows the edge, not them.
      const row = Math.max(floorRow.current, Math.max(0, outlineRow) + LATENT_ROWS_AHEAD, edgeRow + PREFETCH_ROWS - READING_OVERSCAN)
      follower.to(followTarget(Math.min(rows - 1, row), geometry))
      return
    }
    primed.current = true
    el.scrollTop = followTarget(rows - 1, geometry)
  }, [follow, pinned, rows, rowH, box, follower, outlineRow, edgeRow])
  useEffect(() => {
    if (!pinned) follower.stop()
  }, [pinned, follower])

  // Library: one tab stop (the last focused photo, else the selected one, else the first), arrows move it.
  const interactive = Boolean(onSelect) && slots > 0
  const [current, setCurrent] = useState<number | null>(null)
  const selectedIndex = useMemo(() => (selectedId ? items.findIndex((it) => it.id === selectedId) : -1), [items, selectedId])
  const wanted = Math.min(slots - 1, current ?? Math.max(0, selectedIndex))
  // A stop the virtualizer has unmounted can't take Tab: the first photo on screen holds it meanwhile.
  const mountedRows = virtual.getVirtualItems()
  const mountedFirst = (mountedRows[0]?.index ?? 0) * cols
  const mountedLast = ((mountedRows[mountedRows.length - 1]?.index ?? 0) + 1) * cols - 1
  // Live scan: frames above the mounted rows are off screen; the edge never waits on them.
  useEffect(() => {
    if (reading) frontier.pass(mountedFirst)
  }, [reading, mountedFirst, frontier])
  const tabStop = wanted >= mountedFirst && wanted <= mountedLast ? wanted : Math.min(slots - 1, firstRow * cols)
  const pendingFocus = useRef<number | null>(null)
  // A move to a row the virtualizer hasn't mounted yet focuses the cell once it renders.
  useLayoutEffect(() => {
    const target = pendingFocus.current
    const cell = target === null ? null : scroller.current?.querySelector<HTMLElement>(`[data-index="${target}"]`)
    if (!cell) return
    pendingFocus.current = null
    cell.focus()
  })
  const moveFocus = (to: number) => {
    setCurrent(to)
    pendingFocus.current = to
    virtual.scrollToIndex(Math.floor(to / cols), { align: 'auto' })
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (follow && BACK_KEYS.includes(e.key)) {
      follower.stop()
      setPinned(false)
    }
    if (!interactive || !(e.target instanceof HTMLElement) || e.target.dataset.index === undefined) return
    const to = rovingTarget(e.key, Number(e.target.dataset.index), slots, cols)
    if (to === null) return
    e.preventDefault()
    moveFocus(to)
  }

  const dpr = window.devicePixelRatio || 1
  const wide = cellW >= EDGE_DATE_MIN_PX
  // Live rows are in read order: a date there would jump about (2022·01, 2017·08 …; critique round 5, P2-9).
  const edgeDay = (dayKey: string, column: number) => (reading ? undefined : wide ? dayKey : column === 0 ? rowMonthPrint(dayKey) : undefined)
  return (
    <div
      ref={scroller}
      className="sheet-scroll"
      role="group"
      // The library's photos carry the one tab stop; otherwise the scroller itself takes focus to scroll.
      tabIndex={interactive ? undefined : 0}
      aria-label={ariaLabel}
      // Following stops only when the user scrolls back (the sheet's own follow scrolls must not unpin it),
      // and resumes when they reach the end again or press "Jump to newest".
      onScroll={(e) => {
        const el = e.currentTarget
        if (el.scrollHeight - el.scrollTop - el.clientHeight < rowH) setPinned(true)
      }}
      onWheel={(e) => {
        follower.stop()
        if (e.deltaY < 0) setPinned(false)
      }}
      onKeyDown={onKeyDown}
    >
      {items.length === 0 && !reading ? (
        <div className="sheet-empty">{empty}</div>
      ) : (
        <div className="sheet-rows" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((row) => {
            const from = row.index * cols
            const cells: ReactNode[] = []
            for (let c = 0; c < cols; c++) {
              const i = from + c
              const item = items[i]
              if (item) {
                cells.push(
                  <SheetCell
                    key={item.id}
                    item={item}
                    index={i}
                    src={thumbUrl(base, { id: item.id, version: item.version }, cellW, dpr)}
                    frontier={reading ? frontier : undefined}
                    selected={item.id === selectedId}
                    edgeDay={edgeDay(item.dayKey, c)}
                    tabIndex={interactive ? (i === tabStop ? 0 : -1) : undefined}
                    onSelect={onSelect}
                    onCurrent={interactive ? setCurrent : undefined}
                  />,
                )
              } else if (follow) {
                cells.push(<div key={`u${i}`} className="frame-cell unexposed" aria-hidden="true" />)
              }
            }
            return (
              <div
                key={row.key}
                className="strip"
                style={{ transform: `translateY(${row.start}px)`, height: rowH - STRIP_MARGIN, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              >
                {cells}
              </div>
            )
          })}
        </div>
      )}
      {follow && !pinned ? (
        <QuietButton className="jump-newest" onClick={jumpToNewest}>
          Jump to newest
        </QuietButton>
      ) : null}
    </div>
  )
}
