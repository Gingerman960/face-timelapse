import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { PhotoId, PhotoSummary } from '../../ipc/contract'
import { thumbUrl } from '../../ipc/images'
import { formatDayShort } from '../../lib/dates'
import { EdgePrint } from '../../components/ui/EdgePrint'
import { StrikeMark, TickMark } from '../../components/ui/Mark'
import { RetryImg } from '../../components/ui/RetryImg'

/** Queue cells (review.css): 44 px frames, the current one 56 px with 6 px air each side; 5 px gaps. */
const ITEM = 44
const CURRENT = 56 + 12
const GAP = 5
/** Thumbnails cover-fit a square cell: 160 CSS px holds up to the 72 px done cells at 2×. */
const THUMB_CSS_WIDTH = 160
/** The film runs this far past its first and last frames, then is cut square (critique round 4, P2-14). */
const FILM_END = 3

/** A strip's length: as long as its film, never a band wider than its frames. */
export function filmWidth(count: number, hasCurrent: boolean, cell = ITEM): number {
  if (count <= 0) return 0
  return 2 * FILM_END + count * (cell + GAP) - GAP + (hasCurrent ? CURRENT - cell : 0)
}

const STATE_LABEL: Record<PhotoSummary['review'], string> = { pending: 'Not decided', confirmed: 'Kept', rejected: 'Left out' }

/**
 * Where a key moves within the queue (a horizontal listbox), or null for keys
 * it doesn't handle. ⌫ maps to "stay": inside the queue it decides nothing.
 */
export function queueTarget(key: string, from: number, count: number): number | null {
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, from - 1)
    case 'ArrowRight':
      return Math.min(count - 1, from + 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    case 'Backspace':
      return from
    default:
      return null
  }
}

interface ReviewQueueProps {
  list: readonly PhotoSummary[]
  /** The photo under review; null for the read-only strip of the done state. */
  currentId: string | null
  base: string
  /** Without it the strip is a read-only list (Review done: what was kept and left out). */
  onPick?: (index: number) => void
  label?: string
  /** Frame size in px: 44 under the stage, 72 for the done result. */
  cell?: number
  /** The photo just decided: only its tick or strike is written with the pen (critique round 4, P1-5). */
  justDecided?: PhotoId | null
}

/**
 * The film strip of unsure photos under the stage. Virtualized (a library
 * can have hundreds of unsure photos), and it keeps the current photo in
 * view whenever the current photo changes. The strip is as long as its film,
 * cut square 3 px past the last frame; only a film longer than the room it
 * has scrolls, and only then does its end fade.
 */
export function ReviewQueue({ list, currentId, base, onPick, label = 'Unsure photos', cell = ITEM, justDecided = null }: ReviewQueueProps) {
  const strip = useRef<HTMLDivElement>(null)
  const currentIndex = list.findIndex((p) => p.id === currentId)
  const virtual = useVirtualizer({
    horizontal: true,
    count: list.length,
    getScrollElement: () => strip.current,
    estimateSize: (i) => (i === currentIndex ? CURRENT : cell) + GAP,
    overscan: 6,
    initialRect: { width: 640, height: cell },
  })
  const film = filmWidth(list.length, currentIndex >= 0, cell)
  const overflows = (virtual.scrollRect?.width ?? film) + 0.5 < film
  const stripStyle = { '--film-w': `${film}px`, '--cell': `${cell}px` } as CSSProperties

  // Keep the current photo centred; on the read-only result film, the last call (so its pen is seen).
  const decidedIndex = justDecided === null ? -1 : list.findIndex((p) => p.id === justDecided)
  const focusIndex = currentIndex >= 0 ? currentIndex : decidedIndex
  useEffect(() => {
    virtual.measure()
    if (focusIndex >= 0) virtual.scrollToIndex(focusIndex, { align: 'center' })
  }, [currentId, focusIndex, virtual])

  // UI review 2, M2: the arrows browse the queue (roving focus), they never decide the current photo.
  const focusNext = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (focusNext.current === null) return
    const option = strip.current?.querySelector<HTMLElement>(`[aria-posinset="${focusNext.current + 1}"]`)
    if (!option) return
    focusNext.current = null
    option.focus()
  })
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onPick || e.metaKey || e.ctrlKey || e.altKey) return
    const from = Number((e.target as HTMLElement).getAttribute('aria-posinset') ?? currentIndex + 1) - 1
    const target = queueTarget(e.key, from, list.length)
    if (target === null) return
    e.preventDefault()
    if (target === from) return
    // A pick re-renders the strip and focus follows it there; the current photo is
    // already rendered, so it takes focus at once. Never leave a focus target
    // pending, or a later render would pull focus back (UI review 3, L1).
    if (target === currentIndex) {
      strip.current?.querySelector<HTMLElement>(`[aria-posinset="${target + 1}"]`)?.focus()
      return
    }
    focusNext.current = target
    onPick(target)
  }

  const dpr = window.devicePixelRatio || 1
  return (
    // A static list (the done state) has no focusable photos, so the strip itself takes focus to scroll by key (axe: scrollable-region-focusable).
    <div
      className="q-strip"
      ref={strip}
      role={onPick ? 'listbox' : 'list'}
      aria-label={label}
      aria-orientation={onPick ? 'horizontal' : undefined}
      tabIndex={onPick ? undefined : 0}
      onKeyDown={onKeyDown}
      style={stripStyle}
      data-overflow={overflows ? 'true' : undefined}
    >
      <div className="q-track" style={{ width: Math.max(0, virtual.getTotalSize() - GAP) }}>
        {virtual.getVirtualItems().map((item) => {
          const p = list[item.index]
          if (!p) return null
          const isCurrent = p.id === currentId
          const cls = isCurrent ? 'current' : p.review === 'confirmed' ? 'kept' : p.review === 'rejected' ? 'out' : 'pending'
          const name = `${STATE_LABEL[p.review]}, ${formatDayShort(p.dayKey)}`
          const style = { transform: `translateX(${item.start}px)` }
          // Only the mark just made is written with the pen; the rest are already on the film.
          const just = p.id === justDecided && !isCurrent
          const content = (
            <>
              {/* A film of one prints its counter on the rebate (critique round 5, P3-22). */}
              <EdgePrint n={item.index + 1} digits={2} total={list.length === 1 ? 1 : undefined} />
              <RetryImg src={thumbUrl(base, { id: p.id, version: p.version }, THUMB_CSS_WIDTH, dpr)} alt="" loading="lazy" decoding="async" />
              {p.review === 'confirmed' && !isCurrent ? (
                <span className="tick">
                  <TickMark draw={just} />
                </span>
              ) : null}
              {p.review === 'rejected' && !isCurrent ? <StrikeMark draw={just} /> : null}
            </>
          )
          const common = { 'data-id': p.id, 'data-just': just ? 'true' : undefined }
          if (!onPick) {
            return (
              <span key={p.id} role="listitem" aria-label={name} className={`q-item ${cls}`} style={style} {...common}>
                {content}
              </span>
            )
          }
          return (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={isCurrent}
              tabIndex={isCurrent || (currentIndex < 0 && item.index === 0) ? 0 : -1}
              aria-setsize={list.length}
              aria-posinset={item.index + 1}
              aria-label={name}
              className={`q-item ${cls}`}
              style={style}
              {...common}
              onClick={() => onPick(item.index)}
            >
              {content}
            </button>
          )
        })}
      </div>
    </div>
  )
}
