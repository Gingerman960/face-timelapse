import { memo, useCallback, useSyncExternalStore, type CSSProperties } from 'react'
import { Question } from '@phosphor-icons/react'
import type { DayKey, PhotoId, Version } from '../../ipc/contract'
import { EdgePrint } from '../../components/ui/EdgePrint'
import { RetryImg } from '../../components/ui/RetryImg'
import type { FrameFilm, Frontier } from './frontier'
import { latentDelay } from './scanModel'

export interface SheetItem {
  id: PhotoId
  version: Version
  dayKey: DayKey
  /** Unsure matches get the safelight ring; `dim` greys out photos not in the timelapse. */
  unsure?: boolean
  dim?: boolean
  tag?: string
  label: string
}

const NO_STORE = () => () => undefined

/**
 * Live scan: this frame's film and whether it carries the outline, from the
 * developing frontier (latent until the edge releases it, then fresh while it
 * develops, fixed once shown, blank when it can't be read). Only the cells
 * whose film changed re-render.
 */
function useFilm(frontier: Frontier | undefined, index: number): { film: FrameFilm | undefined; outlined: boolean } {
  const subscribe = frontier?.subscribe ?? NO_STORE
  const film = useSyncExternalStore(subscribe, () => frontier?.film(index))
  const outlined = useSyncExternalStore(subscribe, () => frontier?.outline() === index)
  return { film, outlined }
}

/** A develop's start and length ride on the frame, so a batch sweeps along the edge (frontier.ts). */
function developStyle(film: FrameFilm | undefined): CSSProperties | undefined {
  if (film?.film !== 'fresh') return undefined
  return { '--develop-delay': `${film.delay}ms`, '--develop-dur': `${film.duration}ms` } as CSSProperties
}

/** The document clock CSS animations run on (performance.now() where there is no timeline). */
function documentTime(): number {
  const t = document.timeline?.currentTime
  return typeof t === 'number' ? t : performance.now()
}

/**
 * Live scan: sets the frame's breathing delay once, when it mounts, so its
 * `ft-latent` breath is locked to the document clock and trails the frame
 * before it by 160 ms (critique round 4, P2-15). Set on the element, not in
 * render: the delay depends on when the frame mounted.
 */
function usePhaseLock(live: boolean, index: number) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (live && el && !el.style.getPropertyValue('--latent-delay')) el.style.setProperty('--latent-delay', `${latentDelay(index, documentTime())}ms`)
    },
    [live, index],
  )
}

interface SheetCellProps {
  item: SheetItem
  index: number
  src: string
  /** Live scan: the developing frontier this frame's film follows (it reports its image's landing and develop to it). */
  frontier?: Frontier
  selected: boolean
  /** Edge print beside the number: the whole date on wide library cells, the month on a row's first narrow one. */
  edgeDay?: string
  /** Library: 0 for the sheet's one tab stop, -1 for the others (roving tabindex). */
  tabIndex?: number
  onSelect?: (item: SheetItem) => void
  /** Library: told when this cell takes focus or is clicked, so it becomes the tab stop. */
  onCurrent?: (index: number) => void
}

/** One frame on a contact strip: edge print, the photo, and its unsure and tag marks. */
export const SheetCell = memo(function SheetCell({
  item,
  index,
  src,
  frontier,
  selected,
  edgeDay,
  tabIndex,
  onSelect,
  onCurrent,
}: SheetCellProps) {
  const { film, outlined } = useFilm(frontier, index)
  const phaseLock = usePhaseLock(Boolean(frontier), index)
  // Only a developed frame is ever outlined (the frontier's rule); the class is the outline.
  const cls = ['frame-cell', item.unsure && 'unsure', item.dim && 'dim', outlined && 'newest'].filter(Boolean).join(' ')
  const content = (
    <>
      <EdgePrint n={index + 1} day={edgeDay} />
      <RetryImg
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={frontier ? () => frontier.land(index) : undefined}
        // A retry that lands later still develops it; until the edge reaches it, it keeps breathing.
        onError={frontier ? () => frontier.fail(index) : undefined}
        // Developed: the filter, the will-change and the fading latent layer go, and the outline may move here.
        onAnimationEnd={frontier && film?.film === 'fresh' ? () => frontier.developed(index) : undefined}
      />
      {item.unsure ? (
        <span className="q" aria-hidden="true">
          <Question className="icon" weight="bold" />
        </span>
      ) : null}
      {item.tag ? <span className="tag">{item.tag}</span> : null}
    </>
  )
  if (!onSelect) {
    return (
      <div
        ref={phaseLock}
        className={cls}
        data-film={film?.film}
        data-quick={film?.quick ? '' : undefined}
        style={developStyle(film)}
        aria-label={item.label}
        role="img"
      >
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      className={cls}
      data-index={index}
      tabIndex={tabIndex}
      aria-pressed={selected}
      aria-label={item.label}
      onFocus={() => onCurrent?.(index)}
      onClick={() => {
        onCurrent?.(index)
        onSelect(item)
      }}
    >
      {content}
    </button>
  )
})
