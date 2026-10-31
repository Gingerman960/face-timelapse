// The synthetic decade: which days have photos, how many, and the planned
// match status of each one. Deterministic (seeded), pure, environment-agnostic.
//
// Narrative numbers (DESIGN.md / mock brief):
// - 2012-09-01 → 2022-08-31 (3,652 days), 3,593 photos, 101 days without a photo.
// - 40 days with 2–3 photos; 2014-05-02 has 3 (00:41, 08:41, 12:23), 2014-05-03 has 1.
// - Exactly 15 empty days up to 2014-08-30, so that day is frame 714 of 3,547.
// - 2014-04-29 is empty ("No photo on 29 April 2014").
// - Statuses: 3,529 confirmed · 41 uncertain (29 kept, 12 left out on review) · 6 rejected · 17 noFace.
// - The 12th uncertain photo (chronological and relPath order) is 2017-03-03T21:07:14.
import type { DayKey, MatchStatus, ReviewDecision } from '../contract'
import { type Rng, randInt, rngFor, shuffled } from './random'

export const FIRST_DAY: DayKey = '2012-09-01'
export const LAST_DAY: DayKey = '2022-08-31'

const DAY_MS = 86_400_000
const EARLY_END: DayKey = '2014-08-30'
const FORCED_GAP: DayKey = '2014-04-29'
const GAPS_UP_TO_EARLY_END = 15
const GAP_DAYS = 101
const DOUBLE_DAYS = 38
export const REVIEW_SPOTLIGHT_AT = '2017-03-03T21:07:14'
const SPOTLIGHT_DAY: DayKey = '2017-03-03'
const UNCERTAIN_LEFT_OUT_EARLY = 4
const UNCERTAIN_LEFT_OUT_LATE = 8
const UNCERTAIN_KEPT_EARLY = 7
const UNCERTAIN_KEPT_LATE = 21
const NO_FACE_ONLY_DAYS = 4
const NO_FACE_ON_SHARED_DAYS = 13
const REJECTED = 6

/** Days whose content is part of the narrative; random choices never touch them. */
const PROTECTED: ReadonlySet<DayKey> = new Set([
  FIRST_DAY,
  LAST_DAY,
  '2014-04-29',
  '2014-05-02',
  '2014-05-03',
  '2014-08-15',
  EARLY_END,
  SPOTLIGHT_DAY,
])

/** Fixed photo times for narrative days (HH:MM:SS, ascending). */
const FIXED_TIMES: Readonly<Record<DayKey, readonly string[]>> = {
  '2014-05-02': ['00:41:12', '08:41:37', '12:23:05'],
  '2014-08-15': ['14:23:26'],
  [SPOTLIGHT_DAY]: ['21:07:14'],
}

export interface PlannedPhoto {
  dayKey: DayKey
  /** HH:MM:SS local wall time. */
  time: string
  status: MatchStatus
  /** For uncertain photos: what the `reviewed` scenario decides. */
  reviewOutcome: ReviewDecision | null
}

interface Slot {
  status: MatchStatus
  reviewOutcome: ReviewDecision | null
}

const CONFIRMED: Slot = { status: 'confirmed', reviewOutcome: null }

/* ─────────────── Day keys ─────────────── */

/** True for a real calendar date written as YYYY-MM-DD. */
export function isValidDayKey(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return new Date(t).toISOString().slice(0, 10) === value
}

/** Milliseconds (UTC epoch of the naive date) of a day key. */
export function dayMs(dayKey: DayKey): number {
  return Date.parse(`${dayKey}T00:00:00Z`)
}

/** Every day key from FIRST_DAY to LAST_DAY inclusive (3,652 days). */
export function allDayKeys(): DayKey[] {
  const out: DayKey[] = []
  for (let t = dayMs(FIRST_DAY); t <= dayMs(LAST_DAY); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

/** Fraction of the decade elapsed at `dayKey` (0 at FIRST_DAY, 1 at LAST_DAY), clamped. */
export function decadeFraction(dayKey: DayKey): number {
  const f = (dayMs(dayKey) - dayMs(FIRST_DAY)) / (dayMs(LAST_DAY) - dayMs(FIRST_DAY))
  return Math.min(1, Math.max(0, f))
}

/* ─────────────── Planning ─────────────── */

function addGapRuns(gaps: Set<DayKey>, days: readonly DayKey[], lo: number, hi: number, target: number, rng: Rng) {
  while (gaps.size < target) {
    const start = randInt(rng, lo, hi)
    const len = Math.min(1 + Math.floor(rng() * rng() * 5), target - gaps.size)
    const run = days.slice(start, Math.min(start + len, hi + 1))
    if (run.length === len && run.every((d) => !PROTECTED.has(d) && !gaps.has(d))) {
      for (const d of run) gaps.add(d)
    }
  }
}

function chooseGaps(days: readonly DayKey[], rng: Rng): ReadonlySet<DayKey> {
  const gaps = new Set<DayKey>([FORCED_GAP])
  const earlyEnd = days.indexOf(EARLY_END)
  addGapRuns(gaps, days, 0, earlyEnd, GAPS_UP_TO_EARLY_END, rng)
  addGapRuns(gaps, days, earlyEnd + 1, days.length - 1, GAP_DAYS, rng)
  return gaps
}

function randomTime(rng: Rng): string {
  const bucket = rng()
  const hour = bucket < 0.6 ? randInt(rng, 7, 10) : bucket < 0.9 ? randInt(rng, 18, 23) : randInt(rng, 11, 17)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hour)}:${pad(randInt(rng, 0, 59))}:${pad(randInt(rng, 0, 59))}`
}

function timesFor(dayKey: DayKey, count: number, rng: Rng): string[] {
  const fixed = FIXED_TIMES[dayKey]
  if (fixed && fixed.length === count) return fixed.slice()
  const times = new Set<string>()
  while (times.size < count) times.add(randomTime(rng))
  return [...times].sort()
}

/** Takes `n` items from `pool` that pass `accept`, preferring the pool order. */
function take<T>(pool: readonly T[], n: number, accept: (item: T) => boolean, used: Set<T>): T[] {
  const out: T[] = []
  for (const item of pool) {
    if (out.length === n) break
    if (!used.has(item) && accept(item)) {
      out.push(item)
      used.add(item)
    }
  }
  if (out.length < n) throw new Error(`fixture plan: needed ${n}, found ${out.length}`)
  return out
}

const notIn2016 = (d: DayKey) => !d.startsWith('2016-')
const beforeSpotlight = (d: DayKey) => d < SPOTLIGHT_DAY
const afterSpotlight = (d: DayKey) => d > SPOTLIGHT_DAY

function setSlot(plan: Map<DayKey, Slot[]>, day: DayKey, slot: Slot, rng: Rng) {
  const slots = (plan.get(day) ?? [CONFIRMED]).slice()
  slots[Math.floor(rng() * slots.length)] = slot
  plan.set(day, slots)
}

/** The full library plan in chronological order (3,593 photos). */
export function planLibrary(): PlannedPhoto[] {
  const rng = rngFor('ft-library-v1')
  const days = allDayKeys()
  const gaps = chooseGaps(days, rng)
  const photoDays = days.filter((d) => !gaps.has(d))
  const plan = new Map<DayKey, Slot[]>(photoDays.map((d) => [d, [CONFIRMED]]))
  const used = new Set<DayKey>(PROTECTED)

  // Multi-photo days: 2014-05-02 and one random day with 3, 38 days with 2.
  const pool = shuffled(photoDays, rng)
  const [tripleDay] = take(pool, 1, () => true, used)
  const doubles = take(pool, DOUBLE_DAYS, () => true, used)
  plan.set('2014-05-02', [CONFIRMED, CONFIRMED, CONFIRMED])
  plan.set(tripleDay as DayKey, [CONFIRMED, CONFIRMED, CONFIRMED])
  for (const d of doubles) plan.set(d, [CONFIRMED, CONFIRMED])

  // Bad photos on shared days: the day keeps a confirmed photo either way.
  const multi = shuffled([tripleDay as DayKey, ...doubles], rng)
  const multiUsed = new Set<DayKey>()
  const leftOut: Slot = { status: 'uncertain', reviewOutcome: 'rejected' }
  const kept: Slot = { status: 'uncertain', reviewOutcome: 'confirmed' }
  for (const d of take(multi, UNCERTAIN_LEFT_OUT_EARLY, (x) => notIn2016(x) && beforeSpotlight(x), multiUsed)) {
    setSlot(plan, d, leftOut, rng)
  }
  for (const d of take(multi, UNCERTAIN_LEFT_OUT_LATE, (x) => notIn2016(x) && afterSpotlight(x), multiUsed)) {
    setSlot(plan, d, leftOut, rng)
  }
  const sharedBad = take(multi, NO_FACE_ON_SHARED_DAYS + REJECTED, () => true, multiUsed)
  sharedBad.forEach((d, i) => {
    const slot: Slot = { status: i < NO_FACE_ON_SHARED_DAYS ? 'noFace' : 'rejected', reviewOutcome: null }
    setSlot(plan, d, slot, rng)
  })

  // Single days: four with only a no-face photo (after 2014-08-30), 29 kept uncertain photos.
  const singles = shuffled(
    photoDays.filter((d) => (plan.get(d)?.length ?? 1) === 1),
    rng,
  )
  for (const d of take(singles, NO_FACE_ONLY_DAYS, (x) => x > EARLY_END, used)) {
    plan.set(d, [{ status: 'noFace', reviewOutcome: null }])
  }
  plan.set(SPOTLIGHT_DAY, [kept])
  for (const d of take(singles, UNCERTAIN_KEPT_EARLY, (x) => notIn2016(x) && beforeSpotlight(x), used)) {
    plan.set(d, [kept])
  }
  for (const d of take(singles, UNCERTAIN_KEPT_LATE, (x) => notIn2016(x) && afterSpotlight(x), used)) {
    plan.set(d, [kept])
  }

  const out: PlannedPhoto[] = []
  for (const dayKey of photoDays) {
    const slots = plan.get(dayKey) ?? [CONFIRMED]
    const times = timesFor(dayKey, slots.length, rng)
    slots.forEach((slot, i) => {
      out.push({ dayKey, time: times[i] ?? '12:00:00', status: slot.status, reviewOutcome: slot.reviewOutcome })
    })
  }
  return out
}
