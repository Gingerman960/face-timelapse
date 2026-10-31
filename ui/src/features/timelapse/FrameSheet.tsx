import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { FrameSummary } from '../../ipc/contract'
import { alignedUrl } from '../../ipc/images'
import { ToggleChip } from '../../components/ui/Controls'
import { EdgePrint } from '../../components/ui/EdgePrint'
import { DataText } from '../../components/ui/DataText'
import { RetryImg } from '../../components/ui/RetryImg'
import { fitBand, sheetSummary } from './timelapseModel'
import { useContentWidth } from './useElementWidth'

interface FrameSheetProps {
  frames: readonly FrameSummary[]
  base: string
  current: number
  medianResidual: number
  /** Frame width ÷ height (the cells' shape). */
  aspect: number
  onOpen: (index: number) => void
}

const GAP = 3
const TOP = 15
const PAD = 3
const MARGIN = 9
const MIN_COLS = 6
const MAX_COLS = 16
const COL_TARGET = 96
const OVERSCAN = 2
/** Narrower cells print only the frame number on the edge; a date would run into the next cell (P2-14). */
const EDGE_DATE_MIN_W = 150

/** A loose fit: residual above 3× the median (the player caption's "loose" band). */
function looseFit(f: FrameSummary, medianResidual: number): boolean {
  return fitBand(f.residualPx, medianResidual) === 'loose'
}

/** Column count, cell width and row pitch for a content width. */
export function sheetGeometry(width: number, aspect: number): { cols: number; cellW: number; rowH: number } {
  const cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor(width / COL_TARGET)))
  const cellW = (width - 2 * PAD - (cols - 1) * GAP) / cols
  return { cols, cellW, rowH: TOP + PAD + cellW / aspect + MARGIN }
}

/** Every aligned frame as a virtualized contact sheet; outliers (fit > 3× median) are flagged. */
export function FrameSheet({ frames, base, current, medianResidual, aspect, onOpen }: FrameSheetProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const width = useContentWidth(scroller)
  const [byFit, setByFit] = useState(false)
  const order = useMemo(() => {
    const idx = frames.map((_, i) => i)
    return byFit ? idx.sort((a, b) => (frames[b]?.residualPx ?? 0) - (frames[a]?.residualPx ?? 0)) : idx
  }, [frames, byFit])
  const outliers = useMemo(() => frames.filter((f) => looseFit(f, medianResidual)).length, [frames, medianResidual])
  const { cols, cellW, rowH } = sheetGeometry(width, aspect)
  const rows = width > 0 ? Math.ceil(order.length / cols) : 0
  const virtual = useVirtualizer({ count: rows, getScrollElement: () => scroller.current, estimateSize: () => rowH, overscan: OVERSCAN })
  // TanStack Virtual caches row offsets; re-measure before paint whenever the row pitch changes.
  useLayoutEffect(() => {
    virtual.measure()
  }, [rowH, virtual])
  const dpr = window.devicePixelRatio || 1
  return (
    <div className="frame-sheet">
      <div className="sheet-bar">
        <ToggleChip pressed={byFit} onPressedChange={setByFit}>
          Worst fit first
        </ToggleChip>
        <DataText>{sheetSummary(frames.length, outliers)}</DataText>
      </div>
      <div ref={scroller} className="grid-scroll" tabIndex={0} aria-label="All aligned frames">
        <div className="grid-rows" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((row) => (
            <div
              key={row.key}
              className="grid-row"
              style={{ transform: `translateY(${row.start}px)`, height: rowH - MARGIN, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {order.slice(row.index * cols, row.index * cols + cols).map((i) => {
                const f = frames[i]
                if (!f) return null
                const outlier = looseFit(f, medianResidual)
                return (
                  <button
                    key={f.photoId}
                    type="button"
                    className={['grid-cell', outlier && 'outlier'].filter(Boolean).join(' ')}
                    aria-current={i === current}
                    aria-label={`Frame ${i + 1}, ${f.dayKey}${outlier ? ', loose fit' : ''}`}
                    onClick={() => onOpen(i)}
                  >
                    <EdgePrint n={i + 1} day={cellW >= EDGE_DATE_MIN_W ? f.dayKey : undefined} />
                    <RetryImg src={alignedUrl(base, { photoId: f.photoId, version: f.version }, cellW, dpr)} alt="" loading="lazy" decoding="async" draggable={false} />
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
