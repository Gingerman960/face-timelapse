// Boundary validation of command arguments. Every failure throws an
// `invalidArgument` IpcError (plain object), never an Error.
import type {
  AspectPreset,
  BackdropMode,
  CacheScope,
  FrameAdjust,
  ImageExportSettings,
  LookSettings,
  MatchStatus,
  NormalizeMode,
  PhotoQuery,
  Rect,
  RenderSettings,
  Resolution,
  ReviewDecision,
} from '../contract'
import { invalid } from './errors'
import { isValidDayKey } from './fixtures'
import { ASPECT_PRESETS, RESOLUTIONS } from './geometry'

export type Args = Readonly<Record<string, unknown>>

export const MATCH_STATUSES: readonly MatchStatus[] = ['confirmed', 'uncertain', 'rejected', 'noFace', 'failed']
export const REVIEW_DECISIONS: readonly ReviewDecision[] = ['pending', 'confirmed', 'rejected']
const BACKDROPS: readonly BackdropMode[] = ['dimmed', 'blurred', 'black', 'extended']
const NORMALIZE: readonly NormalizeMode[] = ['off', 'exposure', 'exposureAndColor']
const CACHE_SCOPES: readonly CacheScope[] = ['folder', 'all']

const MAX_SHIFT = 0.25
const SCALE_RANGE = [0.5, 2] as const
const MAX_TILT_DEG = 20
const JPEG_QUALITY_RANGE = [50, 100] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The invoke payload as a record (`undefined` ⇒ no args). */
export function argsOf(payload: unknown): Args {
  return isRecord(payload) ? payload : {}
}

function field(args: Args, key: string): unknown {
  return args[key]
}

const bad = (key: string) => invalid(`Missing or invalid "${key}".`)

export function str(args: Args, key: string): string {
  const v = field(args, key)
  if (typeof v !== 'string') throw bad(key)
  return v
}

export function nullableStr(args: Args, key: string): string | null {
  const v = field(args, key)
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw bad(key)
  return v
}

export function num(args: Args, key: string): number {
  const v = field(args, key)
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(key)
  return v
}

export function bool(args: Args, key: string): boolean {
  const v = field(args, key)
  if (typeof v !== 'boolean') throw bad(key)
  return v
}

export function oneOf<T extends string>(args: Args, key: string, values: readonly T[]): T {
  const v = field(args, key)
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw bad(key)
  return v as T
}

export function record(args: Args, key: string): Args {
  const v = field(args, key)
  if (!isRecord(v)) throw bad(key)
  return v
}

export function stringList(args: Args, key: string): string[] {
  const v = field(args, key)
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw bad(key)
  return v as string[]
}

export function dayKey(args: Args, key = 'dayKey'): string {
  const v = str(args, key)
  if (!isValidDayKey(v)) throw invalid(`"${v}" isn't a calendar date (YYYY-MM-DD).`)
  return v
}

export function absolutePath(args: Args, key = 'path'): string {
  const v = str(args, key)
  if (!v.startsWith('/')) throw invalid('Use an absolute path.')
  return v
}

export function rect(args: Args, key: string): Rect {
  const r = record(args, key)
  return { x: num(r, 'x'), y: num(r, 'y'), width: num(r, 'width'), height: num(r, 'height') }
}

export const aspect = (args: Args): AspectPreset => oneOf(args, 'aspect', ASPECT_PRESETS)
export const cacheScope = (args: Args): CacheScope => oneOf(args, 'scope', CACHE_SCOPES)
export const reviewDecision = (args: Args): ReviewDecision => oneOf(args, 'decision', REVIEW_DECISIONS)

export function photoQuery(args: Args): PhotoQuery {
  const q = record(args, 'query')
  const statuses = q.statuses
  if (statuses === null || statuses === undefined) return { statuses: null }
  if (!Array.isArray(statuses) || !statuses.every((s) => (MATCH_STATUSES as readonly unknown[]).includes(s))) {
    throw bad('query.statuses')
  }
  return { statuses: statuses as MatchStatus[] }
}

export function renderSettings(args: Args): RenderSettings {
  const r = record(args, 'render')
  return {
    resolution: oneOf<Resolution>(r, 'resolution', RESOLUTIONS),
    backdrop: oneOf(r, 'backdrop', BACKDROPS),
    refineLandmarks: bool(r, 'refineLandmarks'),
  }
}

export function lookSettings(args: Args): LookSettings {
  const l = record(args, 'look')
  const strength = num(l, 'strength')
  if (strength < 0 || strength > 1) throw invalid('Strength must be between 0 and 1.')
  return { normalize: oneOf(l, 'normalize', NORMALIZE), strength }
}

export function frameAdjust(args: Args): FrameAdjust {
  const a = record(args, 'adjust')
  const adjust = { dx: num(a, 'dx'), dy: num(a, 'dy'), scale: num(a, 'scale'), rotationDeg: num(a, 'rotationDeg') }
  if (Math.abs(adjust.dx) > MAX_SHIFT || Math.abs(adjust.dy) > MAX_SHIFT) {
    throw invalid('Shift the frame by at most a quarter of its size.')
  }
  if (adjust.scale < SCALE_RANGE[0] || adjust.scale > SCALE_RANGE[1]) {
    throw invalid('Scale must be between 0.5 and 2.')
  }
  if (Math.abs(adjust.rotationDeg) > MAX_TILT_DEG) throw invalid('Rotate by at most 20°.')
  return adjust
}

export function imageExportSettings(args: Args): ImageExportSettings {
  const s = record(args, 'settings')
  const jpegQuality = num(s, 'jpegQuality')
  if (!Number.isInteger(jpegQuality) || jpegQuality < JPEG_QUALITY_RANGE[0] || jpegQuality > JPEG_QUALITY_RANGE[1]) {
    throw invalid('JPEG quality must be a whole number from 50 to 100.')
  }
  return { format: oneOf(s, 'format', ['png', 'jpeg']), jpegQuality, overwrite: bool(s, 'overwrite') }
}

/** Event channel argument: anything with an `onmessage` handler (a Tauri `Channel`). */
export function channel<E>(args: Args, key = 'onEvent'): { onmessage: (event: E) => void } {
  const v = field(args, key)
  if (!isRecord(v) && typeof v !== 'object') throw bad(key)
  const sink = v as { onmessage?: unknown } | null
  if (!sink || typeof sink.onmessage !== 'function') throw bad(key)
  return sink as { onmessage: (event: E) => void }
}
