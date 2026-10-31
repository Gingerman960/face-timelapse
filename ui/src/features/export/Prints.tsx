import { useState, type CSSProperties } from 'react'
import type { FrameSummary, Size } from '../../ipc/contract'
import { alignedUrl } from '../../ipc/images'
import { formatDayLong } from '../../lib/dates'
import { EdgePrint } from '../../components/ui/EdgePrint'
import { TickMark } from '../../components/ui/Mark'
import { RetryImg } from '../../components/ui/RetryImg'
import { diptychSize } from './exportModel'
import { inked, printExposed, type SavedStage } from './useSavedSequence'

interface DevelopPrintProps {
  src: string
  alt: string
  className?: string
  /** Whether the print may develop; it does once its image is in as well (true by default). */
  exposed?: boolean
  /** Its image is in (each successful load). */
  onLoaded?: () => void
}

/**
 * A print that surfaces from latent film once it is exposed and its image has
 * landed: the app's develop model, image opacity over --dur-develop (instant
 * under reduced motion).
 */
export function DevelopPrint({ src, alt, className, exposed = true, onLoaded }: DevelopPrintProps) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className={['export-print', className].filter(Boolean).join(' ')} data-film={exposed && loaded ? 'fresh' : 'latent'}>
      <RetryImg
        src={src}
        alt={alt}
        decoding="async"
        onLoad={() => {
          setLoaded(true)
          onLoaded?.()
        }}
      />
    </div>
  )
}

interface DiptychProps {
  base: string
  first: FrameSummary
  last: FrameSummary
  /** The aligned frames' size, for the prints' proportions. */
  master: Size | null
  /** Where the saved moment is (useSavedSequence). */
  stage: SavedStage
  /** Print `i`'s image is in (0 the first day, 1 the last). */
  onLoaded: (i: 0 | 1) => void
}

/**
 * Saved (critique round 5, P2-11): the decade as a photobook spread on a strip
 * of film, the first and the last day about 220 px tall, their dates in edge
 * print ("2012·09·01 ▸ 2022·08·31"). The prints develop one after the other
 * and the pen ticks them across the gutter once both are up. The edge print is
 * decorative; the prints' alt text carries the dates.
 */
export function Diptych({ base, first, last, master, stage, onLoaded }: DiptychProps) {
  const { width, height } = diptychSize(master)
  const dpr = window.devicePixelRatio
  const size = { ['--print-w' as string]: `${width}px`, ['--print-h' as string]: `${height}px` } as CSSProperties
  return (
    <div className="diptych rebate" style={size}>
      <EdgePrint day={first.dayKey} />
      <EdgePrint day="▸" />
      <EdgePrint day={last.dayKey} />
      <DevelopPrint
        className="dip-first"
        src={alignedUrl(base, first, width, dpr)}
        alt={`First day, ${formatDayLong(first.dayKey)}`}
        exposed={printExposed(stage, 0)}
        onLoaded={() => onLoaded(0)}
      />
      <DevelopPrint
        className="dip-last"
        src={alignedUrl(base, last, width, dpr)}
        alt={`Last day, ${formatDayLong(last.dayKey)}`}
        exposed={printExposed(stage, 1)}
        onLoaded={() => onLoaded(1)}
      />
      {inked(stage) ? <TickMark className="dip-tick" draw /> : null}
    </div>
  )
}

/** One image of the encoding print: the first develops from latent film, later ones cross-fade over it. */
interface Layer {
  id: number
  src: string
  shown: boolean
  develop: boolean
}

interface EncodingPrintProps {
  /** The day being encoded, already stepped (about once a second); null before there is one. */
  src: string | null
  className?: string
}

/**
 * The print beside the encoding count (critique round 5, P2-16: it could swap
 * its source every frame). It changes only when `src` does; the new image
 * loads under the shown one and cross-fades in over --dur-xfade, so the print
 * never blinks to its ground, which is latent film, not a well. At most two
 * images are kept: the shown one and the one coming in.
 */
export function EncodingPrint({ src, className }: EncodingPrintProps) {
  const [layers, setLayers] = useState<readonly Layer[]>(() => (src ? [{ id: 0, src, shown: false, develop: true }] : []))
  const [lastSrc, setLastSrc] = useState(src)
  if (src !== lastSrc) {
    setLastSrc(src)
    if (src) {
      const shown = layers.filter((l) => l.shown).at(-1)
      const id = (layers.at(-1)?.id ?? -1) + 1
      setLayers([...(shown ? [shown] : []), { id, src, shown: false, develop: shown === undefined }])
    }
  }
  const show = (id: number) => setLayers((all) => all.map((l) => (l.id === id ? { ...l, shown: true } : l)))
  return (
    <div className={['export-print', 'enc-print', className].filter(Boolean).join(' ')}>
      {layers.map((l) => (
        <RetryImg
          key={l.id}
          src={l.src}
          alt=""
          decoding="async"
          data-shown={l.shown || undefined}
          data-develop={l.develop || undefined}
          onLoad={() => show(l.id)}
        />
      ))}
    </div>
  )
}
