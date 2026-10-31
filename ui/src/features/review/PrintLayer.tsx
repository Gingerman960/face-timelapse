import type { CSSProperties } from 'react'
import { RetryImg } from '../../components/ui/RetryImg'
import { FILL_BLEED_PX, type PrintSpec } from './print'

interface PrintLayerProps {
  spec: PrintSpec
  /** The image's text alternative; empty for a print that isn't the current photo. */
  alt: string
  className?: string
}

/** The fill's reach past the frame, shared with the geometry that sizes it. */
const FILL_STYLE = { ['--fill-bleed' as string]: `${FILL_BLEED_PX}px` } as CSSProperties

/**
 * One print in the candidate frame (also lifted off it as the verdict): the
 * backend's preview of the aligned frame (contract v1.7), or, without one,
 * the photo aligned here, its edges feathered, over a blurred and enlarged
 * copy of itself wherever it leaves the frame (critique round 4). With
 * nothing to align by, the photo cover-fit.
 */
export function PrintLayer({ spec, alt, className }: PrintLayerProps) {
  const size = { width: spec.size.width, height: spec.size.height }
  return (
    <div className={['print', className].filter(Boolean).join(' ')} data-key={spec.key}>
      {spec.kind === 'preview' ? <RetryImg className="cand-preview" src={spec.src} alt={alt} draggable={false} /> : null}
      {spec.kind !== 'preview' && spec.fill ? (
        <div className="print-fill" style={FILL_STYLE} aria-hidden="true">
          <RetryImg src={spec.src} alt="" draggable={false} style={{ ...size, transform: spec.fill }} />
        </div>
      ) : null}
      {spec.kind === 'preview' ? null : spec.transform ? (
        <RetryImg className="cand-img" src={spec.src} alt={alt} draggable={false} style={{ ...size, transform: spec.transform }} />
      ) : (
        <RetryImg className="cand-fallback" src={spec.src} alt={alt} draggable={false} />
      )}
    </div>
  )
}
