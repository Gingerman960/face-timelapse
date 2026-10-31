// ui/src/lib/dates.ts
// Naive local calendar dates (DayKey 'YYYY-MM-DD', LocalDateTime
// 'YYYY-MM-DDTHH:MM:SS'). Pure civil-day arithmetic: no Date objects, no
// time zones, no UTC conversion (ARCHITECTURE.md §9.8). English formatting.
import type { DayKey, LocalDateTime } from '../ipc/contract'

/** A calendar date; month and day are 1-based. */
export interface CalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** A naive local date-time. */
export interface LocalParts extends CalendarDate {
  readonly hour: number
  readonly minute: number
  readonly second: number
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const
/** ISO order: Monday first. */
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})$/
const DAY_KEY_LENGTH = 10
const DAYS_PER_WEEK = 7
const AFTER_MIDNIGHT_END_HOUR = 4
/** 1970-01-01 was a Thursday (ISO index 3). */
const EPOCH_WEEKDAY = 3

/** Caption strftime presets offered in the export sheet. */
export const CAPTION_FORMATS = ['%-d %b %Y', '%b %-d, %Y', '%Y-%m-%d', '%b %Y', '%Y'] as const

/** Zero-pads to `width` digits. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** Gregorian leap year. */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/** 365, or 366 in a leap year. */
export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365
}

/** Days in a 1-based month. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** Days since 1970-01-01 (Hinnant's days_from_civil). */
function toEpochDay({ year, month, day }: CalendarDate): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** Calendar date of an epoch day (Hinnant's civil_from_days). */
function fromEpochDay(epochDay: number): CalendarDate {
  const z = epochDay + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day }
}

/** Parses and validates a DayKey; null when malformed or not a real date. */
export function parseDayKey(dayKey: string): CalendarDate | null {
  const m = DAY_KEY_RE.exec(dayKey)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

/** A camera-style date in a file name: eight digits from 1900–2099, not inside a longer number. */
const FILE_NAME_DATE_RE = /(?:^|\D)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/

/** The date in a camera-style file name ("IMG_20140815_142326.jpg" → 2014-08-15), or null when it has none. */
export function dayKeyFromFileName(name: string): DayKey | null {
  const m = FILE_NAME_DATE_RE.exec(name)
  if (!m) return null
  const key = `${m[1]}-${m[2]}-${m[3]}`
  return parseDayKey(key) ? key : null
}

/** True for a valid DayKey. */
export function isDayKey(value: string): boolean {
  return parseDayKey(value) !== null
}

/** Parses a LocalDateTime; null when malformed or out of range. */
export function parseLocalDateTime(value: string): LocalParts | null {
  const m = LOCAL_RE.exec(value)
  const date = m ? parseDayKey(value.slice(0, DAY_KEY_LENGTH)) : null
  if (!m || !date) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  const second = Number(m[3])
  if (hour > 23 || minute > 59 || second > 59) return null
  return { ...date, hour, minute, second }
}

/** Parses a DayKey or throws a RangeError (formatters fail fast on bad data). */
function requireDate(dayKey: DayKey): CalendarDate {
  const date = parseDayKey(dayKey)
  if (!date) throw new RangeError(`Invalid day key: ${dayKey}`)
  return date
}

/** Parses a LocalDateTime or throws a RangeError. */
function requireLocal(value: LocalDateTime): LocalParts {
  const parts = parseLocalDateTime(value)
  if (!parts) throw new RangeError(`Invalid local date-time: ${value}`)
  return parts
}

/** Builds a DayKey from 1-based parts; throws when they don't form a real date. */
export function makeDayKey(year: number, month: number, day: number): DayKey {
  const key = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
  requireDate(key)
  return key
}

/** DayKey of a date (no validation). */
function keyOf({ year, month, day }: CalendarDate): DayKey {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/** Calendar day of a LocalDateTime (its date part). */
export function dayKeyOf(takenAt: LocalDateTime): DayKey {
  return keyOf(requireLocal(takenAt))
}

/** The day `n` days after `dayKey` (negative goes back). */
export function addDays(dayKey: DayKey, n: number): DayKey {
  return keyOf(fromEpochDay(toEpochDay(requireDate(dayKey)) + n))
}

/** `count` consecutive days from `start` (start first); cheap enough for canvas loops over a decade. */
export function dayRange(start: DayKey, count: number): DayKey[] {
  const first = toEpochDay(requireDate(start))
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => keyOf(fromEpochDay(first + i)))
}

/** Signed days from `from` to `to`. */
export function daysBetween(from: DayKey, to: DayKey): number {
  return toEpochDay(requireDate(to)) - toEpochDay(requireDate(from))
}

/** Zero-based index of `dayKey` counted from `start`. The player's "Day" fact shows it one-based (the first day is Day 1). */
export function dayIndex(dayKey: DayKey, start: DayKey): number {
  return daysBetween(start, dayKey)
}

/** ISO weekday index, 0 = Monday … 6 = Sunday. */
function weekdayIndex(date: CalendarDate): number {
  return (((toEpochDay(date) + EPOCH_WEEKDAY) % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK
}

/** Weekday name of a CalendarDate. */
function weekdayName(date: CalendarDate): string {
  return WEEKDAYS[weekdayIndex(date)] ?? ''
}

/** Month name of a 1-based month. */
function monthName(month: number): string {
  return MONTHS[month - 1] ?? ''
}

/** Full weekday name: "Friday". */
export function weekdayOf(dayKey: DayKey): string {
  return weekdayName(requireDate(dayKey))
}

/** Short weekday name: "Fri". */
export function weekdayShort(dayKey: DayKey): string {
  return weekdayOf(dayKey).slice(0, 3)
}

/** Month as Monday-first weeks of 7 cells; null pads before the 1st and after the last day. */
export function monthGrid(year: number, month: number): Array<Array<DayKey | null>> {
  const first = requireDate(makeDayKey(year, month, 1))
  const lead = weekdayIndex(first)
  const count = daysInMonth(year, month)
  const total = Math.ceil((lead + count) / DAYS_PER_WEEK) * DAYS_PER_WEEK
  const cells = Array.from({ length: total }, (_, i): DayKey | null => {
    const day = i - lead + 1
    return day >= 1 && day <= count ? keyOf({ year, month, day }) : null
  })
  return Array.from({ length: total / DAYS_PER_WEEK }, (_, w) => cells.slice(w * DAYS_PER_WEEK, (w + 1) * DAYS_PER_WEEK))
}

/** Every year touched by the range, ascending (endpoints in any order). */
export function yearsInRange(a: DayKey, b: DayKey): number[] {
  const ya = requireDate(a).year
  const yb = requireDate(b).year
  const lo = Math.min(ya, yb)
  return Array.from({ length: Math.abs(yb - ya) + 1 }, (_, i) => lo + i)
}

/** "14 Aug 2014" (visible dates). */
export function formatDay(dayKey: DayKey): string {
  const { year, month, day } = requireDate(dayKey)
  return `${day} ${monthName(month).slice(0, 3)} ${year}`
}

/** "14 August 2014" (accessible labels, "No photo on 29 April 2014"). */
export function formatDayLong(dayKey: DayKey): string {
  const { year, month, day } = requireDate(dayKey)
  return `${day} ${monthName(month)} ${year}`
}

/** "Fri 3 Mar 2017". */
export function formatDayShort(dayKey: DayKey): string {
  const { year, month, day } = requireDate(dayKey)
  return `${weekdayShort(dayKey)} ${day} ${monthName(month).slice(0, 3)} ${year}`
}

/** "May 2014". */
export function formatMonthYear(dayKey: DayKey): string {
  const { year, month } = requireDate(dayKey)
  return `${monthName(month)} ${year}`
}

/** "14 Aug". */
export function formatShortDate(dayKey: DayKey): string {
  const { month, day } = requireDate(dayKey)
  return `${day} ${monthName(month).slice(0, 3)}`
}

/** "21:07" (24 h). */
export function formatTime(takenAt: LocalDateTime): string {
  const { hour, minute } = requireLocal(takenAt)
  return `${pad(hour, 2)}:${pad(minute, 2)}`
}

/** A photo or frame's moment, and whether it has a real time of day (contract v1.4). */
export interface Moment {
  readonly takenAt: LocalDateTime
  readonly timeKnown: boolean
}

/**
 * "21:07" when the time of day is real, else null: a date-only file name is
 * dated 00:00 and a hand-added photo 12:00, so they show the date only.
 */
export function knownTime(moment: Moment): string | null {
  return moment.timeKnown ? formatTime(moment.takenAt) : null
}

/** Expands one chrono specifier (without '%'); null when unsupported. */
function expand(spec: string, date: CalendarDate): string | null {
  switch (spec) {
    case 'Y': return pad(date.year, 4)
    case 'y': return pad(date.year % 100, 2)
    case 'm': return pad(date.month, 2)
    case 'd': return pad(date.day, 2)
    case '-d': return String(date.day)
    case 'e': return String(date.day).padStart(2, ' ')
    case 'b': return monthName(date.month).slice(0, 3)
    case 'B': return monthName(date.month)
    case 'a': return weekdayName(date).slice(0, 3)
    case 'A': return weekdayName(date)
    case '%': return '%'
    default: return null
  }
}

/** chrono-compatible strftime for captions: %Y %m %d %-d %b %B %a %A %e %y %%; unknown specifiers stay literal. */
export function strftime(format: string, dayKey: DayKey): string {
  const date = requireDate(dayKey)
  return format.replace(/%(-?.)/gs, (token, spec: string) => expand(spec, date) ?? token)
}

/** True when a photo was taken before 04:00 (suggest moving it to the previous day); never without a known time. */
export function isAfterMidnightHint(moment: Moment): boolean {
  const parts = moment.timeKnown ? parseLocalDateTime(moment.takenAt) : null
  return parts !== null && parts.hour < AFTER_MIDNIGHT_END_HOUR
}
