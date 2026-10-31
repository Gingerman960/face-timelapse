import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import type { FrameSummary } from '../../ipc/contract'
import { alignedUrl } from '../../ipc/images'
import { holdTransition, isCapturing, vtPrintName } from '../shell/stepTransition'

interface TransitionPrintProps {
  frame: FrameSummary
  base: string
  /** The cell's rendered size, CSS px (picks the width bucket). */
  cellPx: number
}

/**
 * The print becomes the film (signature moment 3; critique round 5, P1-2):
 * the selected day's aligned frame, laid over its cell and shown only while a
 * screen change runs (html.vt). It carries the day's transition name, as the
 * player's frame does, so the same picture of the same day grows into the
 * player and shrinks back into its cell, at matching crops (both cover a
 * centred frame). Mounted inside a transition, it holds the capture until its
 * picture is decoded (or fails to be).
 */
export function TransitionPrint({ frame, base, cellPx }: TransitionPrintProps) {
  const img = useRef<HTMLImageElement>(null)
  useLayoutEffect(() => {
    const el = img.current
    // Only while a transition captures (UI review 6, L1): a plain selection decodes nothing, and a
    // picture that can't be decoded just releases the hold.
    if (el && typeof el.decode === 'function' && isCapturing()) holdTransition(el.decode().catch(() => undefined))
  }, [])
  const style = { '--vt-print': vtPrintName(frame.dayKey) } as CSSProperties
  return (
    <span className="vt-print" data-vt-print="" style={style} aria-hidden="true">
      <img ref={img} src={alignedUrl(base, frame, cellPx, window.devicePixelRatio)} alt="" decoding="async" draggable={false} />
    </span>
  )
}
