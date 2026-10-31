import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { fitFrameHeight, frameAxis, playingFrameWidth, stripCount } from './playerLayout'

interface PlayerMeasure {
  /** The player column's width (inside its padding); 0 before layout. */
  width: number
  /** The frame's centre from the column's left edge and the column width; null before layout. */
  axis: { cx: number; columnWidth: number } | null
  /** The frame's width while playing (the strip folded away); 0 before layout. */
  printWidth: number
}

const UNMEASURED: PlayerMeasure = { width: 0, axis: null, printWidth: 0 }

/** Half-pixel rounding keeps sub-pixel layout noise from re-rendering the player. */
function half(x: number): number {
  return Math.round(x * 2) / 2
}

function sameMeasure(a: PlayerMeasure, b: PlayerMeasure): boolean {
  return a.width === b.width && a.axis?.cx === b.axis?.cx && a.axis?.columnWidth === b.axis?.columnWidth && a.printWidth === b.printWidth
}

/** A length custom property of `style` in px (0 when unset). */
function lengthVar(style: CSSStyleDeclaration, name: string): number {
  return parseFloat(style.getPropertyValue(name)) || 0
}

/**
 * The element's left edge from `ancestor`'s border box, from layout alone
 * (offsets), so a transform in flight (the frame's FLIP) never skews it.
 * Falls back to the drawn boxes when `ancestor` isn't in the offset chain.
 */
function layoutLeft(el: HTMLElement, ancestor: HTMLElement): number {
  let left = 0
  let node: HTMLElement | null = el
  while (node && node !== ancestor) {
    left += node.offsetLeft
    node = node.offsetParent as HTMLElement | null
  }
  return node === ancestor ? left : el.getBoundingClientRect().left - ancestor.getBoundingClientRect().left
}

/** What the plate caption needs beside the frame: the stage's --stage-lead, --caption-min and two column gaps. */
function captionReserve(stage: HTMLElement | null): number {
  if (!stage) return 0
  const style = getComputedStyle(stage)
  return lengthVar(style, '--stage-lead') + lengthVar(style, '--caption-min') + 2 * (parseFloat(style.columnGap) || 0)
}

function measure(el: HTMLElement, frame: HTMLElement | null, aspect: number, prevAxis: PlayerMeasure['axis']): PlayerMeasure {
  const style = getComputedStyle(el)
  const padLeft = parseFloat(style.paddingLeft) || 0
  const padRight = parseFloat(style.paddingRight) || 0
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
  const width = Math.max(0, el.clientWidth - padLeft - padRight)
  const inPlace = frame && !frame.classList.contains('viewer-frame') ? frame : null
  const found = inPlace ? frameAxis({ left: layoutLeft(inPlace, el), width: inPlace.offsetWidth }, { left: 0, width: el.offsetWidth }, padLeft, padRight) : prevAxis
  const transport = el.querySelector<HTMLElement>(':scope > .transport')
  const printWidth = playingFrameWidth({
    columnWidth: width,
    contentHeight: el.clientHeight - padY,
    transportHeight: transport?.offsetHeight ?? 0,
    aspect,
    reserve: captionReserve(frame?.parentElement ?? null),
  })
  return {
    width: half(width),
    axis: found ? { cx: half(found.cx), columnWidth: half(found.columnWidth) } : null,
    printWidth,
  }
}

interface PlayerFit {
  ref: RefObject<HTMLDivElement | null>
  /** Frames on the filmstrip. */
  strip: number
  /** The frame's width while playing, the same paused and playing (0 before layout). */
  printWidth: number
  /** `data-axis` and its custom properties for the `.player` element. */
  axis: { 'data-axis'?: 'frame'; style: CSSProperties }
}

/**
 * Fits the player to its column (QA 30, P2-11, critique round 4 P1-2): how
 * many frames the filmstrip shows, the frame's axis that the transport and
 * filmstrip centre on, and the frame's width while playing, which picks its
 * image size so that pressing Space never changes it. Attach `ref` and `axis`
 * to `.player`; `frameRef` is the frame's figure (ignored while it is the
 * full-window viewer).
 */
export function usePlayerFit(aspect: number, frameRef: RefObject<HTMLElement | null>): PlayerFit {
  const ref = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<PlayerMeasure>(UNMEASURED)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      setFit((prev) => {
        const next = measure(el, frameRef.current, aspect, prev.axis)
        return sameMeasure(prev, next) ? prev : next
      })
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    if (frameRef.current) ro.observe(frameRef.current)
    return () => ro.disconnect()
  }, [frameRef, aspect])
  const { width, axis, printWidth } = fit
  return {
    ref,
    strip: stripCount(width, aspect),
    printWidth,
    axis: axis
      ? { 'data-axis': 'frame', style: { ['--frame-cx' as string]: `${axis.cx}px`, ['--col-w' as string]: `${axis.columnWidth}px` } }
      : { style: {} },
  }
}

/** Caps the frame's height on `stage` (--frame-fit-h) so it fits beside the caption, or lifts the cap. */
function applyStageFit(stage: HTMLElement, aspect: number): void {
  const fit = fitFrameHeight(stage.clientWidth, stage.clientHeight, aspect, captionReserve(stage))
  if (fit === null) stage.style.removeProperty('--frame-fit-h')
  else stage.style.setProperty('--frame-fit-h', `${fit}px`)
}

/**
 * Keeps the frame beside its plate caption on a narrow stage: the stage's CSS
 * says what the caption needs (--stage-lead, --caption-min and the column
 * gap), and the frame's height is capped through --frame-fit-h so that it
 * fits. The cap is written straight to the stage, in the resize observer's
 * pass (before paint) and whenever `refit` is called: the player calls it the
 * moment playback folds the filmstrip away, so the frame's new box is final
 * in the same layout pass (critique round 4, P1-2). Attach `ref` to the
 * `.player-stage` element; React leaves the property alone.
 */
export function useStageFit(aspect: number): { ref: RefObject<HTMLDivElement | null>; refit: () => void } {
  const ref = useRef<HTMLDivElement>(null)
  const refit = useCallback(() => {
    if (ref.current) applyStageFit(ref.current, aspect)
  }, [aspect])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    refit()
    const ro = new ResizeObserver(refit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [refit])
  return { ref, refit }
}
