import { useRef, type CSSProperties, type PointerEvent } from 'react'
import { Warning } from '@phosphor-icons/react'
import type { AspectPreset, Rect, ReferenceState } from '../../ipc/contract'
import { moveCrop, resizeCrop, type CropHandle } from '../../lib/crop'
import { formatCount } from '../../lib/format'
import { RetryImg } from '../../components/ui/RetryImg'

const CORNERS: CropHandle[] = ['nw', 'ne', 'sw', 'se']
const EDGES: CropHandle[] = ['n', 'e', 's', 'w']

interface CropEditorProps {
  /** The reference has just arrived: the print develops in and the template draws itself (signature moment 6). */
  arrival?: boolean
  reference: ReferenceState
  imageUrl: string
  crop: Rect
  aspect: AspectPreset
  /** True while the user drags or the draft differs from the committed crop. */
  stale: boolean
  onDraft: (crop: Rect) => void
  onDragChange: (dragging: boolean) => void
}

interface DragState {
  mode: 'move' | CropHandle
  startX: number
  startY: number
  start: Rect
  scale: number
}

function rel(v: number, total: number): number {
  return total > 0 ? v / total : 0
}

/** The face template drawn from the backend's detection (crop-normalized). */
function Template({ reference }: { reference: ReferenceState }) {
  const det = reference.detection
  if (!det) return null
  const [le, re, nose, ml, mr] = det.anchors
  if (!le || !re) return null
  const eyeY = (le.y + re.y) / 2
  const midX = (le.x + re.x) / 2
  const fb = det.faceBox
  return (
    <>
      <svg className="template" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
        <ellipse cx={fb.x + fb.width / 2} cy={fb.y + fb.height / 2} rx={fb.width / 2} ry={fb.height / 2} />
        <line x1={0} y1={eyeY} x2={1} y2={eyeY} />
        <line x1={midX} y1={0} x2={midX} y2={1} />
        <line className="t-chin" x1={fb.x + fb.width * 0.2} y1={fb.y + fb.height} x2={fb.x + fb.width * 0.8} y2={fb.y + fb.height} />
      </svg>
      {[le, re].map((p, i) => (
        <span key={`e${i}`} className="anchor" style={{ ['--ax' as string]: p.x, ['--ay' as string]: p.y } as CSSProperties} aria-hidden="true" />
      ))}
      {[nose, ml, mr].map((p, i) =>
        p ? <span key={`m${i}`} className="anchor minor" style={{ ['--ax' as string]: p.x, ['--ay' as string]: p.y } as CSSProperties} aria-hidden="true" /> : null,
      )}
    </>
  )
}

/** The reference print with an editable crop: drag to move, brackets/edges to resize. */
export function CropEditor({ reference, imageUrl, crop, aspect, stale, arrival, onDraft, onDragChange }: CropEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const size = reference.image.size
  const vars = {
    ['--ar' as string]: `${size.width} / ${size.height}`,
    ['--x' as string]: rel(crop.x, size.width),
    ['--y' as string]: rel(crop.y, size.height),
    ['--w' as string]: rel(crop.width, size.width),
    ['--h' as string]: rel(crop.height, size.height),
  } as CSSProperties
  const noFace = reference.detection === null && !stale

  function begin(e: PointerEvent<HTMLElement>, mode: DragState['mode']) {
    if (e.button !== 0 || !host.current) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const scale = size.width / host.current.getBoundingClientRect().width
    drag.current = { mode, startX: e.clientX, startY: e.clientY, start: crop, scale }
    onDragChange(true)
  }

  function move(e: PointerEvent<HTMLElement>) {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.startX) * d.scale
    const dy = (e.clientY - d.startY) * d.scale
    onDraft(d.mode === 'move' ? moveCrop(d.start, dx, dy, size) : resizeCrop(d.start, d.mode, dx, dy, size, aspect))
  }

  function end(e: PointerEvent<HTMLElement>) {
    if (!drag.current) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    onDragChange(false)
  }

  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end }
  return (
    <div ref={host} className="crop-host" style={vars} data-arrival={arrival ? 'true' : undefined}>
      <RetryImg className="ref-print" src={imageUrl} alt={`Reference photo ${reference.image.fileName}`} draggable={false} />
      <div className="crop-shade" aria-hidden="true" />
      <div
        className="crop"
        role="group"
        tabIndex={0}
        aria-label={`Crop ${formatCount(Math.round(crop.width))} by ${formatCount(Math.round(crop.height))} pixels. Arrow keys move it; Shift moves 10 pixels.`}
        data-noface={noFace ? 'true' : undefined}
        onPointerDown={(e) => begin(e, 'move')}
        {...handlers}
      >
        {stale ? <span className="thirds" aria-hidden="true" /> : <Template reference={reference} />}
        {EDGES.map((h) => (
          <span key={h} className={`edge-hit ${h}`} aria-hidden="true" onPointerDown={(e) => begin(e, h)} {...handlers} />
        ))}
        {CORNERS.map((h) => (
          <span key={h} className={`corner ${h}`} aria-hidden="true" onPointerDown={(e) => begin(e, h)} {...handlers} />
        ))}
        {noFace ? (
          <span className="crop-hint">
            <Warning className="icon" aria-hidden="true" />
            No face inside the crop
          </span>
        ) : null}
        <span className="crop-size mono-meta" aria-hidden="true">
          {Math.round(crop.width)} × {Math.round(crop.height)} px
        </span>
      </div>
    </div>
  )
}
