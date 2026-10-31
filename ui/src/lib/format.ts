// ui/src/lib/format.ts
// Display formats for counts, durations, sizes and exposure (DESIGN.md copy).
// English, thin and predictable: no Intl, so output is identical everywhere.
import type { Platform } from '../ipc/contract'

/** Shown when a numeric input is not finite. */
export const PLACEHOLDER = '—'
/** Real minus sign (U+2212), not a hyphen. */
const MINUS = '−'
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600
const MS_PER_SECOND = 1000
/** ETAs below this read "Almost done". */
const ALMOST_DONE_MS = 3000
const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const
const BYTES_PER_UNIT = 1000
/** Values below this keep one decimal ("4.2 GB", "2.5 photos/s"). */
const ONE_DECIMAL_BELOW = 9.95
const MAX_ZONE = 10

/** Inserts thousands separators into a non-negative integer string. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** "3,593"; rounds to an integer. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return PLACEHOLDER
  const rounded = Math.round(Math.abs(n))
  const sign = n < 0 && rounded !== 0 ? MINUS : ''
  return `${sign}${groupThousands(String(rounded))}`
}

/** One decimal below ~10 with a trailing ".0" dropped, else a grouped integer. */
function compactNumber(x: number): string {
  return x < ONE_DECIMAL_BELOW ? String(Number(x.toFixed(1))) : formatCount(x)
}

/** Two-digit zero pad. */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** "36 s", "1 min 32 s", "1 h 4 min" (hours round to the minute). */
export function formatDuration(ms: number): string {
  const secs = Number.isFinite(ms) ? Math.max(0, Math.round(ms / MS_PER_SECOND)) : 0
  if (secs < SECONDS_PER_MINUTE) return `${secs} s`
  if (secs < SECONDS_PER_HOUR) {
    const rest = secs % SECONDS_PER_MINUTE
    const minutes = `${Math.floor(secs / SECONDS_PER_MINUTE)} min`
    return rest === 0 ? minutes : `${minutes} ${rest} s`
  }
  const totalMinutes = Math.round(secs / SECONDS_PER_MINUTE)
  const minutes = totalMinutes % SECONDS_PER_MINUTE
  const hours = `${Math.floor(totalMinutes / SECONDS_PER_MINUTE)} h`
  return minutes === 0 ? hours : `${hours} ${minutes} min`
}

/** "About 36 s left" / "Almost done" / "Estimating…" (null or invalid ETA). */
export function formatEta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'Estimating…'
  if (ms < ALMOST_DONE_MS) return 'Almost done'
  return `About ${formatDuration(ms)} left`
}

/** Player timecode "01:58.2" (tenths), "1:01:58.2" past an hour. */
export function formatTimecode(secs: number): string {
  const tenths = Number.isFinite(secs) ? Math.max(0, Math.round(secs * 10)) : 0
  const whole = Math.floor(tenths / 10)
  const tail = `${pad2(Math.floor(whole / SECONDS_PER_MINUTE) % SECONDS_PER_MINUTE)}:${pad2(whole % SECONDS_PER_MINUTE)}.${tenths % 10}`
  const hours = Math.floor(whole / SECONDS_PER_HOUR)
  return hours > 0 ? `${hours}:${tail}` : tail
}

/** Decimal (SI) sizes like Finder: "236 MB", "4.2 GB", "980 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return PLACEHOLDER
  let value = bytes
  let unit = 0
  while (value >= BYTES_PER_UNIT - 0.5 && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT
    unit += 1
  }
  const text = unit === 0 ? String(Math.round(value)) : compactNumber(value)
  return `${text} ${BYTE_UNITS[unit]}`
}

/** Vulgar fraction glyph for a remainder of thirds. */
function thirdGlyph(remainder: number): string {
  if (remainder === 1) return '⅓'
  return remainder === 2 ? '⅔' : ''
}

/** Whole part plus a vulgar third: 4 → "1⅓", 2 → "⅔", 0 → "0". */
function thirdsText(thirds: number): string {
  const whole = Math.floor(thirds / 3)
  const fraction = thirdGlyph(thirds % 3)
  if (whole === 0) return fraction === '' ? '0' : fraction
  return `${whole}${fraction}`
}

/** Exposure in stops to the nearest third: "+⅔ EV", "−1⅓ EV", "0 EV". */
export function formatEv(ev: number): string {
  if (!Number.isFinite(ev)) return PLACEHOLDER
  const thirds = Math.round(Math.abs(ev) * 3)
  if (thirds === 0) return '0 EV'
  return `${ev < 0 ? MINUS : '+'}${thirdsText(thirds)} EV`
}

/** Zone System value to the nearest third, clamped to 0–10: "5⅓". */
export function formatZone(zone: number): string {
  if (!Number.isFinite(zone)) return PLACEHOLDER
  return thirdsText(Math.round(Math.min(MAX_ZONE, Math.max(0, zone)) * 3))
}

/** Fraction as a percentage: 0.342 → "34%". */
export function formatPercent(fraction: number, decimals = 0): string {
  if (!Number.isFinite(fraction)) return PLACEHOLDER
  const text = (Math.abs(fraction) * 100).toFixed(decimals)
  const sign = fraction < 0 && Number(text) !== 0 ? MINUS : ''
  return `${sign}${text}%`
}

/** Throughput: "38 photos/s", "2.5 frames/s". */
export function formatRate(perSecond: number, noun: string): string {
  if (!Number.isFinite(perSecond)) return `${PLACEHOLDER} ${noun}/s`
  return `${compactNumber(Math.max(0, perSecond))} ${noun}/s`
}

/** The word for `count` items: pluralize(1, 'photo') → "photo", pluralize(3, 'day') → "days". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural
}

/** A count with its noun: countOf(1, 'photo') → "1 photo", countOf(3591, 'photo') → "3,591 photos". */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${pluralize(count, singular, plural)}`
}

/** "this Mac" / "this PC" / "this computer", for local-only copy. */
export function thisMachine(platform: Platform | undefined): string {
  return platform === 'windows' ? 'this PC' : platform === 'linux' ? 'this computer' : 'this Mac'
}

const CLOCK_SECONDS_PER_MINUTE = 60
const CLOCK_SECONDS_PER_HOUR = 3600

/** "2:59", "1:02:05": whole seconds as a video length reads. */
function clock(whole: number): string {
  const s = Math.max(0, whole)
  const hours = Math.floor(s / CLOCK_SECONDS_PER_HOUR)
  const minutes = Math.floor(s / CLOCK_SECONDS_PER_MINUTE) % CLOCK_SECONDS_PER_MINUTE
  const seconds = String(s % CLOCK_SECONDS_PER_MINUTE).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** A video length, rounded to the second: "3:00" for 179.6 s, "1:02:05" past an hour (the ledger and the transport). */
export function formatLength(secs: number): string {
  return clock(Number.isFinite(secs) ? Math.round(secs) : 0)
}

/** A playhead's time in the same format, counting whole seconds reached. */
export function formatElapsed(secs: number): string {
  return clock(Number.isFinite(secs) ? Math.floor(secs) : 0)
}

