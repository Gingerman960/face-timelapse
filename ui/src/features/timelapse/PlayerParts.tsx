import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { alignedUrl } from '../../ipc/images'
import { EdgePrint } from '../../components/ui/EdgePrint'
import { RetryImg } from '../../components/ui/RetryImg'
import { usePlayer } from '../../state/player'
import { STRIP_MAX } from './playerLayout'
import { stripKeyTarget } from './timelapseModel'

/** The playhead the UI follows: exact when paused, ~4 Hz while playing. */
export function useSettledIndex(): number {
  return usePlayer((s) => s.settled)
}

/** CSS width of a strip frame. */
const STRIP_FRAME_W = 46
/** Stagger between frames developing in together. */
const DEVELOP_STAGGER_MS = 90

interface FilmstripProps {
  frames: ReadonlyArray<{ photoId: string; version: string; dayKey: string }>
  center: number
  base: string
  /** Moves the playhead; a strip that picks moves its tab stop with the playhead (selection follows focus). */
  onPick?: (index: number) => void
  developFrom?: number
  label: string
  /** Frames to show (odd, so the playhead sits in the middle); fewer in a narrow player. */
  count?: number
  /** Out of sight (folded away while playing): holds what it shows, no renders or thumbnail loads, until it is back. */
  frozen?: boolean
}

/**
 * Where the strip's one tab stop sits and how the keys move it (critique
 * round 4, item 21: 19 tab stops became one). A strip that picks keeps it on
 * the playhead, and ←/→ (⇧ ten), Home and End move the playhead across the
 * whole timelapse; the aligning strip moves it across the frames shown. Focus
 * follows the stop while it is in the strip.
 */
function useRovingStrip(span: { from: number; last: number; center: number; total: number }, onPick: ((index: number) => void) | undefined) {
  const { from, last, center, total } = span
  const list = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  // The stop a key just asked for: focus goes there even if the focused frame left the strip.
  const keyed = useRef<number | null>(null)
  const active = onPick || cursor === null ? center : Math.max(from, Math.min(last, cursor))
  useLayoutEffect(() => {
    const el = list.current
    const asked = keyed.current === active
    keyed.current = null
    if (!el || !(asked || el.contains(document.activeElement))) return
    el.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus({ preventScroll: true })
  }, [active])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return
    const target = onPick ? stripKeyTarget(e.key, e.shiftKey, active, 0, total - 1) : stripKeyTarget(e.key, e.shiftKey, active, from, last)
    if (target === null) return
    // Handled here: the player's own ←/→/Home/End must not step again.
    e.preventDefault()
    if (target === active) return
    keyed.current = target
    if (onPick) onPick(target)
    else setCursor(target)
  }
  const pick = (i: number) => {
    setCursor(i)
    onPick?.(i)
  }
  return { list, active, onKeyDown, pick }
}

/**
 * A contact strip of the frames around the playhead (edge print = frame
 * number; only the playhead frame keeps the "▸"). One tab stop (roving
 * tabindex). Frames developing in (while aligning) surface by image opacity
 * over a latent rebate tone, the scan sheet's model (critique round 4, item 13).
 */
function FilmstripView({ frames, center, base, onPick, developFrom, label, count = STRIP_MAX }: FilmstripProps) {
  const from = Math.max(0, Math.min(center - Math.floor(count / 2), frames.length - count))
  const slice = frames.slice(from, from + count)
  const { list, active, onKeyDown, pick } = useRovingStrip({ from, last: from + slice.length - 1, center, total: frames.length }, onPick)
  const dpr = window.devicePixelRatio
  return (
    <div ref={list} className="filmstrip" role="listbox" aria-label={label} aria-orientation="horizontal" onKeyDown={onKeyDown}>
      {slice.map((f, k) => {
        const i = from + k
        const now = i === center
        const develop = developFrom !== undefined && i >= developFrom
        const delay = develop ? { ['--d' as string]: `${(i - developFrom) * DEVELOP_STAGGER_MS}ms` } : undefined
        return (
          <button
            key={`${f.photoId}-${f.version}`}
            type="button"
            role="option"
            data-index={i}
            tabIndex={i === active ? 0 : -1}
            aria-selected={now}
            aria-label={`Frame ${i + 1}, ${f.dayKey}`}
            className={now ? 'film now' : 'film'}
            data-develop={develop || undefined}
            style={delay}
            onClick={() => pick(i)}
          >
            {/* "▸ 0002" is wider than a 3:4 film cell (42 px): only the playhead frame, which has the room, keeps the marker. */}
            <EdgePrint n={i + 1} marker={now} />
            <RetryImg src={alignedUrl(base, { photoId: f.photoId, version: f.version }, STRIP_FRAME_W, dpr)} alt="" loading="lazy" decoding="async" draggable={false} />
          </button>
        )
      })}
    </div>
  )
}

/** The strip; while `frozen` it skips every update, and renders once it thaws. */
export const Filmstrip = memo(FilmstripView, (prev, next) => Boolean(prev.frozen && next.frozen))
