import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PhotoDetail, PhotoId, PhotoSummary, Point } from '../../ipc/contract'
import { RETRY_DELAYS_MS, RetryImg } from '../../components/ui/RetryImg'
import { PrintLayer } from './PrintLayer'
import { previewSrc, printSpec, printSrc, type PrintSpec } from './print'
import { decodePrint, isPrintDecoded } from './printCache'

/** Quiet retries of a preview before the print falls back to aligning here (a 404 or a shed request). */
const PREVIEW_RETRIES_MS = RETRY_DELAYS_MS.slice(0, 2)
const NO_FAILURES: ReadonlySet<string> = new Set()

/**
 * Decodes a print; a preview that fails is retried quietly (it may have been
 * shed under load) before it counts as failed.
 */
async function decodeQuietly(spec: PrintSpec, live: () => boolean): Promise<boolean> {
  if (await decodePrint(spec.src)) return true
  if (spec.kind !== 'preview') return true
  for (const delay of PREVIEW_RETRIES_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (!live()) return false
    if (await decodePrint(spec.src)) return true
  }
  return false
}

/** How a print arrives: over the one before it (browsing), or out of the well (after a decision). */
type Entrance = 'xfade' | 'rise'

interface Layer {
  spec: PrintSpec
  entrance: Entrance
}

/** The print on show for the current photo, for the verdict to lift off the table. */
export interface ShownPrint {
  spec: PrintSpec
  frame: HTMLElement
}

interface CandidateProps {
  photo: PhotoSummary
  detail: PhotoDetail | undefined
  /** True while the detail is on its way: the outgoing print holds instead of the unaligned photo flashing. */
  detailPending?: boolean
  /** Reference anchors normalized to the output frame (crop-normalized). */
  refAnchors: Point[] | null
  base: string
  referenceFrameUrl: string | null
  compare: boolean
  alt: string
  /** The photo just decided: its print left as the verdict, so it never shows here again. */
  justDecided?: PhotoId | null
  /** Told which print is on show for the current photo (null while another photo's print holds). */
  onShown?: (shown: ShownPrint | null) => void
}

function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setSize((s) => (s && s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }))
    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    return () => ro.disconnect()
  }, [])
  return { ref, size }
}

function sameSpec(a: PrintSpec, b: PrintSpec): boolean {
  return a.key === b.key && a.kind === b.kind && a.src === b.src && a.transform === b.transform && a.fill === b.fill
}

/**
 * The layers once `next` is ready to show. The same photo updates in place (a
 * resize, a re-read detail). Another photo goes on top: it rises from the
 * well when the print before it was just decided (that one left as the
 * verdict), and otherwise cross-fades over it. Never more than two layers.
 */
export function withPrint(layers: readonly Layer[], next: PrintSpec, decided: PhotoId | null): readonly Layer[] {
  const top = layers.at(-1)
  if (top?.spec.key === next.key) return sameSpec(top.spec, next) ? layers : [...layers.slice(0, -1), { ...top, spec: next }]
  if (!top || top.spec.key === decided) return [{ spec: next, entrance: 'rise' }]
  return [top, { spec: next, entrance: 'xfade' }]
}

/**
 * The unsure photo shown already aligned to the reference: a similarity
 * transform from its matched face's 5 anchors onto the reference anchors,
 * applied as a CSS matrix to the source thumbnail (no new image route), over
 * an extended-edge fill (critique round 4, P1-4).
 *
 * A new photo's print waits until its detail is known and its thumbnail is
 * decoded (both usually prefetched), and the outgoing print holds meanwhile:
 * a held print dims only if the wait outlasts a short grace. Then the new
 * print cross-fades in over `--dur-xfade`, or after a decision rises from the
 * well over `--dur-base`. A newer photo replaces a pending one at once, so
 * input never waits for a print.
 */
export function Candidate({ photo, detail, detailPending = false, refAnchors, base, referenceFrameUrl, compare, alt, justDecided = null, onShown }: CandidateProps) {
  const { ref, size } = useBoxSize<HTMLDivElement>()
  const dpr = window.devicePixelRatio || 1
  const src = printSrc(base, photo, dpr)
  // v1.7: the backend's preview of the aligned frame, unless it couldn't be had (then align here).
  const [failed, setFailed] = useState<ReadonlySet<string>>(NO_FAILURES)
  const wanted = detail?.previewVersion ? previewSrc(base, photo.id, detail.previewVersion, dpr) : null
  const preview = wanted && !failed.has(wanted) ? wanted : null
  const target = useMemo(
    () => printSpec({ photo, detail, detailPending, refAnchors, frame: size, src, previewSrc: preview }),
    [photo, detail, detailPending, refAnchors, size, src, preview],
  )
  const [layers, setLayers] = useState<readonly Layer[]>([])
  // What the commit below reads when its decode lands, after later renders.
  const latest = useRef({ layers, decided: justDecided })
  useLayoutEffect(() => {
    latest.current = { layers, decided: justDecided }
  })

  useLayoutEffect(() => {
    if (!target) return
    const show = () => setLayers((prev) => withPrint(prev, target, latest.current.decided))
    if (latest.current.layers.at(-1)?.spec.key === target.key || isPrintDecoded(target.src)) {
      show()
      return
    }
    let live = true
    void decodeQuietly(target, () => live).then((ok) => {
      if (!live) return
      if (ok) show()
      else setFailed((prev) => new Set(prev).add(target.src))
    })
    return () => {
      live = false
    }
  }, [target])

  // The print just decided is flying to its queue slot: it never shows here again.
  const visible = layers.filter((l) => l.spec.key !== justDecided || l.spec.key === photo.id)
  const top = visible.at(-1)
  const showing = top && top.spec.key === photo.id ? top.spec : null
  useLayoutEffect(() => {
    const frame = ref.current
    onShown?.(showing && frame ? { spec: showing, frame } : null)
  }, [showing, onShown, ref])
  useLayoutEffect(() => () => onShown?.(null), [onShown])

  // Once the top print has faded in, the one under it goes (a native listener:
  // React's synthetic animation events are vendor-prefixed outside browsers).
  useLayoutEffect(() => {
    const frame = ref.current
    if (!frame) return
    const settle = (e: Event) => {
      const el = e.target
      if (!(el instanceof HTMLElement) || !el.classList.contains('print') || el.parentElement !== frame) return
      setLayers((prev) => (prev.length > 1 && prev.at(-1)?.spec.key === el.dataset.key ? prev.slice(-1) : prev))
    }
    frame.addEventListener('animationend', settle)
    return () => frame.removeEventListener('animationend', settle)
  }, [ref])
  const eyes = refAnchors && refAnchors.length >= 2 ? refAnchors : null
  return (
    <div ref={ref} className="candidate-frame" data-compare={compare ? 'true' : 'false'}>
      {visible.map((layer) => {
        const isTop = layer === top
        const current = layer.spec.key === photo.id
        return (
          <PrintLayer
            key={layer.spec.key}
            spec={layer.spec}
            alt={current ? alt : ''}
            className={[isTop ? layer.entrance : 'under', current ? '' : 'held'].filter(Boolean).join(' ')}
          />
        )
      })}
      {referenceFrameUrl ? <RetryImg className="onion" src={referenceFrameUrl} alt="" aria-hidden="true" /> : null}
      {eyes && eyes[0] && eyes[1] ? (
        <svg className="template" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <line x1={0} y1={(eyes[0].y + eyes[1].y) / 2} x2={1} y2={(eyes[0].y + eyes[1].y) / 2} />
          <line x1={(eyes[0].x + eyes[1].x) / 2} y1={0} x2={(eyes[0].x + eyes[1].x) / 2} y2={1} />
        </svg>
      ) : null}
    </div>
  )
}
