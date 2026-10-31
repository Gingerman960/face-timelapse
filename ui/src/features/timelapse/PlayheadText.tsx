import { useLayoutEffect, useRef } from 'react'
import type { DayKey } from '../../ipc/contract'
import { usePlayer } from '../../state/player'

interface PlayheadTextProps {
  /** The frames the playhead walks. */
  frames: ReadonlyArray<{ dayKey: DayKey }>
  /** The text for a day ("5 Nov", "2016"); module-level, so it never changes between renders. */
  format: (day: DayKey) => string
  as?: 'p' | 'span'
  className?: string
  id?: string
}

/**
 * Text that follows the playhead at frame rate (critique round 5, P2-17: the
 * hero date ticked with the ~4 Hz settled index). A player store subscription
 * writes the element's text straight through a ref whenever the day changes,
 * so playback never renders React for it; React renders the element empty and
 * leaves its text alone. Written before the first paint (a layout effect).
 */
export function PlayheadText({ frames, format, as: Tag = 'p', className, id }: PlayheadTextProps) {
  const ref = useRef<HTMLParagraphElement & HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let shown: string | null = null
    const write = (index: number) => {
      const frame = frames[Math.max(0, Math.min(index, frames.length - 1))]
      const text = frame ? format(frame.dayKey) : ''
      if (text === shown) return
      shown = text
      el.textContent = text
    }
    write(usePlayer.getState().index)
    return usePlayer.subscribe((s, prev) => {
      if (s.index !== prev.index) write(s.index)
    })
  }, [frames, format])
  return <Tag ref={ref} className={className} id={id} />
}
