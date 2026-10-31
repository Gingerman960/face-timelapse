// Pure Scan rules: the ribbon follows the sheet, the read time reads well, the
// live sheet glides and breathes in phase, and the tally names what's true now.
import type { DayKey, LibraryCounts, ReviewDecision } from '../../ipc/contract'
import { formatDuration } from '../../lib/format'

/** Below this a scan "took no time": formatDuration would round it to "0 s". */
const UNDER_A_SECOND_MS = 500

/** Anything with a day: a contact-sheet item or a photo. */
interface Dated {
  readonly dayKey: DayKey
}

/** Earliest and latest day among items `first`..`last` (inclusive, clamped), or null when none are on screen. */
export function visibleDays(items: readonly Dated[], first: number, last: number): { start: DayKey; end: DayKey } | null {
  const shown = items.slice(Math.max(0, first), Math.max(0, last) + 1)
  if (shown.length === 0) return null
  let start = shown[0]?.dayKey as DayKey
  let end = start
  for (const item of shown) {
    if (item.dayKey < start) start = item.dayKey
    if (item.dayKey > end) end = item.dayKey
  }
  return { start, end }
}

/**
 * The live ribbon's focus year (critique round 5, P2-9). Photos are read in
 * no order of date, so following the last one read jumped years
 * every row. This holds `held` until another year has strictly more days
 * found; when it has to choose among equals it takes the later year. With
 * nothing found yet it keeps `held`.
 */
export function liveFocusYear(days: Iterable<DayKey>, held: number | null): number | null {
  const perYear = new Map<number, number>()
  for (const day of days) {
    const year = Number(day.slice(0, 4))
    perYear.set(year, (perYear.get(year) ?? 0) + 1)
  }
  if (perYear.size === 0) return held
  const most = Math.max(...perYear.values())
  if (held !== null && (perYear.get(held) ?? 0) >= most) return held
  return Math.max(...[...perYear].filter(([, n]) => n === most).map(([year]) => year))
}

/** The first item dated `day` or later (the last item when all are earlier): where a ribbon seek scrolls to. */
export function firstItemOnOrAfter(items: readonly Dated[], day: DayKey): number {
  const at = items.findIndex((item) => item.dayKey >= day)
  return at >= 0 ? at : Math.max(0, items.length - 1)
}

/** "Read in 43 s"; a cached rescan reads "Read in under a second" (critique round 2: not "Read in 0 s"). */
export function readTimeText(durationMs: number): string {
  return durationMs < UNDER_A_SECOND_MS ? 'Read in under a second' : `Read in ${formatDuration(durationMs)}`
}

/** Latent frames breathe for 2.4 s each way (`ft-latent`, alternate): one breath in and out. */
export const LATENT_CYCLE_MS = 4800
/** Each frame breathes this far behind the one before it, so a run of them reads as one wave. */
const LATENT_STEP_MS = 160

function mod(n: number, m: number): number {
  return ((n % m) + m) % m
}

/**
 * The `animation-delay` (ms, never positive) for latent frame `index` whose
 * animation starts at document time `mountedAt` (critique round 4, P2-15).
 * Every frame is then locked to the document clock, whenever it mounted, and
 * frame i + 1 trails frame i by 160 ms: the latent run breathes as one wave
 * travelling toward the leading edge instead of twinkling out of phase.
 */
export function latentDelay(index: number, mountedAt: number): number {
  return -mod(mountedAt - index * LATENT_STEP_MS, LATENT_CYCLE_MS)
}

/** A row's month as edge print on its first frame: "2020·11". */
export function rowMonthPrint(dayKey: DayKey): string {
  return `${dayKey.slice(0, 4)}·${dayKey.slice(5, 7)}`
}

/** The live sheet's geometry, CSS px: row pitch, the margin under each strip, the scroller's padding and view, the rows' total height. */
export interface SheetGeometry {
  rowH: number
  gap: number
  padTop: number
  padBottom: number
  viewport: number
  total: number
}

/** The scrollTop that shows row `row`'s strip (and the padding under it) at the bottom of the view, within the content. */
export function followTarget(row: number, g: SheetGeometry): number {
  const end = g.padTop + row * g.rowH + (g.rowH - g.gap) + g.padBottom
  const max = Math.max(0, g.padTop + g.total + g.padBottom - g.viewport)
  return Math.min(max, Math.max(0, end - g.viewport))
}

/** One item of the tally line under the Scan statement. */
export type TallyKind = 'you' | 'unsure' | 'kept' | 'leftOut' | 'other' | 'cache' | 'failed'

export interface TallyItem {
  kind: TallyKind
  count: number
  label: string
}

const TALLY_LABELS: Record<TallyKind, string> = {
  you: 'you',
  unsure: 'unsure',
  kept: 'kept',
  leftOut: 'left out',
  other: 'someone else or no face',
  cache: 'remembered from the last scan',
  failed: 'couldn’t be read',
}

function item(kind: TallyKind, count: number): TallyItem {
  return { kind, count, label: TALLY_LABELS[kind] }
}

/** The counts a running scan reports. */
interface LiveCounts {
  confirmed: number
  uncertain: number
  rejected: number
  noFace: number
  fromCache: number
  failed: number
}

/**
 * The running scan's tally: you, unsure and someone else stay on the line
 * from the first frame (they fill at once, and a line that grows items as it
 * counts would reflow); remembered and unreadable photos join at its end.
 */
export function liveTally(p: LiveCounts): TallyItem[] {
  return [
    item('you', p.confirmed),
    item('unsure', p.uncertain),
    item('other', p.rejected + p.noFace),
    item('cache', p.fromCache),
    item('failed', p.failed),
  ].filter((t) => t.count > 0 || t.kind === 'you' || t.kind === 'unsure' || t.kind === 'other')
}

/**
 * The library's tally (critique round 4, P2-16): "you" counts the photos in
 * the timelapse pool (so the kept are in it), unsure only those still waiting,
 * kept and left out from the review's decisions, and nothing at zero.
 */
export function libraryTally(c: LibraryCounts, unsure: ReadonlyArray<{ review: ReviewDecision }> | undefined, fromCache: number): TallyItem[] {
  const decided = unsure ?? []
  return [
    item('you', c.included),
    item('unsure', c.reviewPending),
    item('kept', decided.filter((p) => p.review === 'confirmed').length),
    item('leftOut', decided.filter((p) => p.review === 'rejected').length),
    item('other', c.rejected + c.noFace),
    item('cache', fromCache),
    item('failed', c.failed),
  ].filter((t) => t.count > 0)
}

/**
 * The library sheet's roving focus (QA §12 item 21): where `key` moves the
 * focus from photo `index` of `count` in rows of `cols`, or null for a key
 * it doesn't own. ←/→ step one photo, ↑/↓ one row (↓ into a short last row
 * lands on its last photo), Home/End go to the ends; at an edge it stays.
 */
export function rovingTarget(key: string, index: number, count: number, cols: number): number | null {
  if (count <= 0) return null
  const last = count - 1
  const below = index + cols
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, index - 1)
    case 'ArrowRight':
      return Math.min(last, index + 1)
    case 'ArrowUp':
      return index - cols >= 0 ? index - cols : index
    case 'ArrowDown':
      if (below <= last) return below
      return Math.floor(index / cols) < Math.floor(last / cols) ? last : index
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}
