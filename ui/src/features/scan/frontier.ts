// The live sheet's developing frontier (critique round 5, P1-6).
//
// Thumbnails land out of order, so lighting each frame as its image arrived
// made about three rows twinkle (lit, ghosted and black frames mixed), and an
// outline that followed the highest loaded index jumped onto frames still
// black. Here frames develop in order along one leading edge:
//   - the edge waits on the first frame whose image hasn't landed; frames that
//     land ahead of it stay latent (held), for at most HOLD_MS, after which the
//     edge passes the frames still waiting (they develop when they land);
//   - frames the edge releases together start their develops a step apart (the
//     reading pace), so a batch, even a burst of rows, sweeps along the edge
//     instead of lighting as a block (MAX_SWEEP_MS bounds the queue);
//   - a develop lasts about four frames of reading (the four newest develop at
//     once), the whole sigmoid on a slow scan, an opacity-only fade on a fast one;
//   - the outline moves when a develop ends, onto the highest developed frame
//     with nothing before it still developing or held.
//
// The rules are pure functions over an immutable state; `createFrontier` is
// the small store the sheet's cells subscribe to.

/** A live-scan frame's film: latent while its image is on its way (or held), fresh while it develops, fixed once shown, blank when it can't be read. */
export type Film = 'latent' | 'fresh' | 'fixed' | 'blank'

export interface FrameFilm {
  readonly film: Film
  /** A develop's start delay and length, ms (0 for every film but fresh). */
  readonly delay: number
  readonly duration: number
  /** Too short for the contrast easing to show (and more than four would carry a filter): opacity only. */
  readonly quick: boolean
}

interface Develop extends FrameFilm {
  /** When the develop counts as ended even if its animation never reported (unmounted, hidden window). */
  readonly endsBy: number
}

export interface FrontierState {
  /** Frames read so far. */
  readonly count: number
  /** The release edge: every frame below it has passed (developing, fixed, blank, or late). */
  readonly edge: number
  /** Frames at or past the edge whose image has landed, held latent: index → when it landed. */
  readonly held: ReadonlyMap<number, number>
  /** Frames at or past the edge whose image failed (a retry may still land). */
  readonly failed: ReadonlySet<number>
  /** Frames the edge passed while their image was still on its way: latent until it lands. */
  readonly late: ReadonlySet<number>
  /** Frames the edge passed whose image failed. */
  readonly blank: ReadonlySet<number>
  readonly developing: ReadonlyMap<number, Develop>
  /** The outlined frame, -1 for none. Never moves back. */
  readonly outline: number
  /** The earliest time the next develop may start, so a batch sweeps along the edge. */
  readonly nextStart: number
  /** Milliseconds per frame read, smoothed; null until two reads. */
  readonly pace: number | null
  readonly lastReadAt: number | null
}

/** The longest an early arrival is held latent waiting for the frames before it. */
export const HOLD_MS = 400
/** `--dur-true-develop` (tokens.css): a slow scan's develop, the signature moment's full sigmoid. */
export const TRUE_DEVELOP_MS = 900
/** How many frames develop at once: a develop lasts this many frames of reading. */
const DEVELOP_TAIL = 4
/** The shortest develop: still a fade, never a snap. */
const MIN_DEVELOP_MS = 160
/** Below this the contrast easing can't be seen, and more than four frames would carry a filter. */
const FILTER_MIN_MS = 320
/** The longest step between develops in one batch. */
const MAX_STEP_MS = 60
/**
 * A burst of arrivals (a row scrolled into view, a cache hit) sweeps along the
 * edge at the reading pace rather than developing as a block: develops queue
 * up to SWEEP_EASE_MS ahead at full steps, then the steps shrink so the queue
 * never reaches MAX_SWEEP_MS (batch 13 integration: clamping every delay to
 * the hold made a burst of 80 light as one block, eight rows deep).
 */
const SWEEP_EASE_MS = 1500
export const MAX_SWEEP_MS = 3000
/**
 * Both points are also bounded in frames of reading (QA §14 P1-1). On a fast
 * scan 1.5 s of full steps held about 125 frames, and releases come at the
 * reading pace, so a backlog never drained: the outline trailed the release
 * edge by two screens. Now the steps shrink past 10 frames, so the sweep
 * develops in larger batches until it is back within a few rows of the edge.
 * At a slow pace these are the 1.5 s and 3 s points.
 */
const SWEEP_EASE_FRAMES = 10
export const MAX_SWEEP_FRAMES = 120
/** A develop that hasn't reported this long after it should have ended is ended. */
const DEVELOP_GRACE_MS = 250
/** Weight of each new reading interval in the smoothed pace. */
const PACE_SMOOTHING = 0.25

const LATENT: FrameFilm = Object.freeze({ film: 'latent', delay: 0, duration: 0, quick: false })
const FIXED: FrameFilm = Object.freeze({ film: 'fixed', delay: 0, duration: 0, quick: false })
const BLANK: FrameFilm = Object.freeze({ film: 'blank', delay: 0, duration: 0, quick: false })

const EMPTY_MAP: ReadonlyMap<number, never> = new Map<number, never>()
const EMPTY_SET: ReadonlySet<number> = new Set<number>()

export function initialFrontier(): FrontierState {
  return {
    count: 0,
    edge: 0,
    held: EMPTY_MAP,
    failed: EMPTY_SET,
    late: EMPTY_SET,
    blank: EMPTY_SET,
    developing: EMPTY_MAP,
    outline: -1,
    nextStart: 0,
    pace: null,
    lastReadAt: null,
  }
}

/** Frame `index`'s film; the same object for as long as it doesn't change. */
export function filmOf(s: FrontierState, index: number): FrameFilm {
  if (index >= s.edge || s.late.has(index)) return LATENT
  if (s.blank.has(index)) return BLANK
  return s.developing.get(index) ?? FIXED
}

function without<K>(set: ReadonlySet<K>, drop: readonly K[]): ReadonlySet<K> {
  if (drop.length === 0) return set
  const next = new Set(set)
  for (const k of drop) next.delete(k)
  return next
}

function withAll<K>(set: ReadonlySet<K>, add: readonly K[]): ReadonlySet<K> {
  if (add.length === 0) return set
  return new Set([...set, ...add])
}

function withoutKeys<K, V>(map: ReadonlyMap<K, V>, drop: readonly K[]): ReadonlyMap<K, V> {
  if (drop.length === 0) return map
  const next = new Map(map)
  for (const k of drop) next.delete(k)
  return next
}

/** How long a develop lasts at this pace: about four frames of reading, within the floor and the full sigmoid. */
function developLength(pace: number | null): number {
  if (pace === null) return TRUE_DEVELOP_MS
  return Math.round(Math.min(TRUE_DEVELOP_MS, Math.max(MIN_DEVELOP_MS, DEVELOP_TAIL * pace)))
}

/**
 * The outline: the highest fixed frame below the first frame still developing
 * or not yet passed. Frames passed while waiting (late) and blank frames are
 * never outlined, and don't hold it back.
 */
function outlineOf(s: FrontierState): number {
  let bound = s.edge
  for (const i of s.developing.keys()) bound = Math.min(bound, i)
  for (let i = bound - 1; i > s.outline; i--) {
    if (!s.late.has(i) && !s.blank.has(i)) return i
  }
  return s.outline
}

function settle(s: FrontierState): FrontierState {
  const outline = outlineOf(s)
  return outline === s.outline ? s : { ...s, outline }
}

/** The highest held frame that has waited its full hold: the edge may pass every frame before it. */
function expiredHold(held: ReadonlyMap<number, number>, now: number): number {
  let upTo = -1
  for (const [i, at] of held) if (now - at >= HOLD_MS) upTo = Math.max(upTo, i)
  return upTo
}

/** Starts the develops of frames the edge released together, a step apart. */
function release(s: FrontierState, frames: readonly number[], now: number): Pick<FrontierState, 'developing' | 'nextStart'> {
  if (frames.length === 0) return { developing: s.developing, nextStart: s.nextStart }
  const duration = developLength(s.pace)
  const fullStep = Math.min(s.pace ?? MAX_STEP_MS, MAX_STEP_MS)
  // A fast scan's queue is a few rows long: behind, the sweep takes larger batches and catches up.
  const ease = Math.min(SWEEP_EASE_MS, SWEEP_EASE_FRAMES * fullStep)
  const cap = Math.min(MAX_SWEEP_MS, MAX_SWEEP_FRAMES * fullStep)
  const developing = new Map(s.developing)
  let next = Math.max(now, s.nextStart)
  for (const i of frames) {
    const delay = Math.round(next - now)
    const start = now + delay
    developing.set(i, { film: 'fresh', delay, duration, quick: duration < FILTER_MIN_MS, endsBy: start + duration + DEVELOP_GRACE_MS })
    // Past the easing point the steps shrink in proportion to the room left, so the queue never reaches the cap.
    const queued = next - now
    const room = queued <= ease ? 1 : Math.max(0, (cap - queued) / (cap - ease))
    next += fullStep * room
  }
  return { developing, nextStart: next }
}

/** Moves the edge over every frame it may pass now, and starts the develops it releases. */
function advance(s: FrontierState, now: number): FrontierState {
  const expiredUpTo = expiredHold(s.held, now)
  const released: number[] = []
  const blanks: number[] = []
  const lates: number[] = []
  let edge = s.edge
  while (edge < s.count) {
    if (s.held.has(edge)) released.push(edge)
    else if (s.failed.has(edge)) blanks.push(edge)
    else if (edge < expiredUpTo) lates.push(edge)
    else break
    edge++
  }
  if (edge === s.edge) return s
  return settle({
    ...s,
    edge,
    held: withoutKeys(s.held, released),
    failed: without(s.failed, blanks),
    late: withAll(s.late, lates),
    blank: withAll(s.blank, blanks),
    ...release(s, released, now),
  })
}

/** `count` frames have been read. A shorter list is a new scan. */
export function readTo(s: FrontierState, count: number, now: number): FrontierState {
  if (count < s.count) return { ...initialFrontier(), count, lastReadAt: now }
  if (count === s.count) return s
  const sample = s.lastReadAt === null ? null : (now - s.lastReadAt) / (count - s.count)
  const pace = sample === null ? s.pace : s.pace === null ? sample : s.pace + PACE_SMOOTHING * (sample - s.pace)
  return advance({ ...s, count, pace, lastReadAt: now }, now)
}

/** Frame `index`'s image has landed. */
export function landed(s: FrontierState, index: number, now: number): FrontierState {
  if (index >= s.edge) {
    if (s.held.has(index)) return s
    return advance({ ...s, held: new Map([...s.held, [index, now]]), failed: without(s.failed, [index]) }, now)
  }
  // Behind the edge: a late frame or a retry just appears.
  if (s.late.has(index)) return settle({ ...s, late: without(s.late, [index]) })
  if (s.blank.has(index)) return settle({ ...s, blank: without(s.blank, [index]) })
  return s
}

/** Frame `index`'s image failed to load (it may still land on a retry). */
export function failedAt(s: FrontierState, index: number, now: number): FrontierState {
  if (index >= s.edge) {
    if (s.held.has(index) || s.failed.has(index)) return s
    return advance({ ...s, failed: withAll(s.failed, [index]) }, now)
  }
  // A late frame that fails stops breathing.
  if (s.late.has(index)) return { ...s, late: without(s.late, [index]), blank: withAll(s.blank, [index]) }
  return s
}

/** Frame `index`'s develop has ended. */
export function developEnded(s: FrontierState, index: number, _now: number): FrontierState {
  if (!s.developing.has(index)) return s
  return settle({ ...s, developing: withoutKeys(s.developing, [index]) })
}

/**
 * Frames below `index` are off screen above the mounted rows (a sheet opened
 * mid-scan, or scrolled on past the edge): the edge passes them without
 * developing. Landed ones are fixed, failed ones blank, the rest wait latent.
 */
export function passBefore(s: FrontierState, index: number, now: number): FrontierState {
  const to = Math.min(index, s.count)
  if (to <= s.edge) return s
  const fixed: number[] = []
  const blanks: number[] = []
  const lates: number[] = []
  for (let i = s.edge; i < to; i++) {
    if (s.held.has(i)) fixed.push(i)
    else if (s.failed.has(i)) blanks.push(i)
    else lates.push(i)
  }
  const passed = settle({
    ...s,
    edge: to,
    held: withoutKeys(s.held, fixed),
    failed: without(s.failed, blanks),
    late: withAll(s.late, lates),
    blank: withAll(s.blank, blanks),
  })
  return advance(passed, now)
}

/** Time moved on: ends develops past their deadline, and lets holds run out. */
export function tick(s: FrontierState, now: number): FrontierState {
  const overdue = [...s.developing].filter(([, d]) => d.endsBy <= now).map(([i]) => i)
  const ended = overdue.length > 0 ? settle({ ...s, developing: withoutKeys(s.developing, overdue) }) : s
  return advance(ended, now)
}

/** When the frontier next needs a `tick` (a hold running out, a develop's deadline), or null. */
export function wakeAt(s: FrontierState, now: number): number | null {
  let at = Infinity
  for (const landedAt of s.held.values()) if (landedAt + HOLD_MS > now) at = Math.min(at, landedAt + HOLD_MS)
  for (const d of s.developing.values()) if (d.endsBy > now) at = Math.min(at, d.endsBy)
  return Number.isFinite(at) ? at : null
}

/** The frontier as a store: the sheet reports reads, landings and develops; each cell subscribes to its own film. */
export interface Frontier {
  subscribe: (listener: () => void) => () => void
  film: (index: number) => FrameFilm
  outline: () => number
  /** The release edge: how many frames have passed it (developing, fixed, blank or late). */
  edge: () => number
  read: (count: number) => void
  land: (index: number) => void
  fail: (index: number) => void
  developed: (index: number) => void
  pass: (index: number) => void
  /** Stops the pending wake-up (the next event schedules again). */
  dispose: () => void
}

interface Clock {
  now: () => number
}

const documentClock: Clock = { now: () => performance.now() }

export function createFrontier(clock: Clock = documentClock): Frontier {
  let state = initialFrontier()
  let timer: ReturnType<typeof setTimeout> | null = null
  /** The moment the pending timer is for, so an event that doesn't move it keeps the timer. */
  let timerAt: number | null = null
  const listeners = new Set<() => void>()

  const clear = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    timerAt = null
  }
  const wake = () => {
    timer = null
    timerAt = null
    const next = tick(state, clock.now())
    // A timer that fired a hair early changes nothing: wait for the same moment again.
    if (next === state) schedule()
    else apply(next)
  }
  function schedule(): void {
    const now = clock.now()
    const at = wakeAt(state, now)
    if (at === timerAt && timer !== null) return
    clear()
    if (at === null) return
    timerAt = at
    timer = setTimeout(wake, Math.max(0, at - now))
  }
  function apply(next: FrontierState): void {
    if (next === state) return
    state = next
    schedule()
    for (const listener of listeners) listener()
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    film: (index) => filmOf(state, index),
    outline: () => state.outline,
    edge: () => state.edge,
    read: (count) => apply(readTo(state, count, clock.now())),
    land: (index) => apply(landed(state, index, clock.now())),
    fail: (index) => apply(failedAt(state, index, clock.now())),
    developed: (index) => apply(developEnded(state, index, clock.now())),
    pass: (index) => apply(passBefore(state, index, clock.now())),
    dispose: clear,
  }
}
