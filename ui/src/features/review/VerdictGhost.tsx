import { useLayoutEffect, useRef } from 'react'
import type { PhotoId } from '../../ipc/contract'
import { StrikeMark, TickMark } from '../../components/ui/Mark'
import { PrintLayer } from './PrintLayer'
import type { PrintSpec } from './print'
import { flightPlan, type Box } from './verdictFlight'

/** The print just decided, lifted off the table at the frame's place. */
export interface Flight {
  id: PhotoId
  review: 'confirmed' | 'rejected'
  spec: PrintSpec
  /** Where the print was, in viewport coordinates, when the call was made. */
  from: Box
}

interface VerdictGhostProps {
  flight: Flight
  onDone: () => void
}

function within(rect: Box, origin: Box): Box {
  return { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height }
}

/** The decided photo's queue slot, when it is on the visible part of the film. */
function slotOf(root: ParentNode, id: PhotoId): Box | null {
  const slot = root.querySelector(`.q-item[data-id="${id}"]`)
  const film = slot?.closest('.q-strip')
  if (!slot || !film) return null
  const box = slot.getBoundingClientRect()
  const view = film.getBoundingClientRect()
  const centre = box.left + box.width / 2
  return box.height > 0 && centre >= view.left && centre <= view.right ? box : null
}

const nextFrame = (fn: () => void): (() => void) => {
  if (typeof requestAnimationFrame !== 'function') {
    const t = setTimeout(fn, 0)
    return () => clearTimeout(t)
  }
  const id = requestAnimationFrame(fn)
  return () => cancelAnimationFrame(id)
}

/**
 * The verdict (critique round 4, signature moment 2): the decided print takes
 * its chinagraph mark (a tick on its corner when kept, a strike across it in
 * greyscale when left out, written with the pen) and flies into its slot on
 * the queue, on transform and opacity only. Mounted once per decision: the
 * next decision unmounts it, which ends its flight at once, so a held key is
 * never kept waiting. Without WAAPI it finishes immediately.
 */
export function VerdictGhost({ flight, onDone }: VerdictGhostProps) {
  const el = useRef<HTMLDivElement>(null)
  const done = useRef(onDone)
  useLayoutEffect(() => {
    done.current = onDone
  })

  useLayoutEffect(() => {
    const node = el.current
    const layer = node?.parentElement
    if (!node || !layer) return
    const origin = layer.getBoundingClientRect()
    const start = within(flight.from, origin)
    node.style.left = `${start.left}px`
    node.style.top = `${start.top}px`
    node.style.width = `${start.width}px`
    node.style.height = `${start.height}px`
    if (typeof node.animate !== 'function') {
      done.current()
      return
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let live = true
    let running: Animation[] = []
    // A frame later, so the queue has re-centred on the next photo before its slot is measured.
    const cancelFrame = nextFrame(() => {
      const slot = slotOf(layer.parentElement ?? document, flight.id)
      const plan = flightPlan(start, slot ? within(slot, origin) : null, flight.review, reduced)
      running = [
        ...(plan.transform ? [node.animate(plan.transform, plan.timing)] : []),
        node.animate(plan.opacity, plan.opacityTiming),
      ]
      Promise.all(running.map((a) => a.finished)).then(
        () => {
          if (live) done.current()
        },
        () => undefined,
      )
    })
    return () => {
      live = false
      cancelFrame()
      for (const a of running) a.cancel()
    }
  }, [flight])

  return (
    <div ref={el} className="verdict" data-review={flight.review} aria-hidden="true">
      <div className="verdict-print">
        <PrintLayer spec={flight.spec} alt="" />
      </div>
      {flight.review === 'confirmed' ? (
        <span className="verdict-mark tick">
          <TickMark draw />
        </span>
      ) : (
        <span className="verdict-mark strike">
          <StrikeMark draw />
        </span>
      )}
    </div>
  )
}
