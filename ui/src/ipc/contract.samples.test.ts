// Contract drift guard, TypeScript half (ARCHITECTURE.md §7.6).
//
// Compile time: `contract.samples.ts` declares every shared sample with
// `satisfies <ContractType>`, so `tsc` fails on missing/extra/mistyped fields.
// Run time: the typed samples must deep-equal the JSON the Rust test
// (`src-tauri/tests/contract.rs`) round-trips through the Rust types.
//
// UI wiring (DESIGN/UI agent): copy this file, `contract.samples.ts` and
// `contract.samples.json` to `ui/src/ipc/`, keep `contract.ts` there (verbatim
// §7.3), and point the Rust test at the moved JSON (see INTEGRATION-NOTES.md).
import { describe, expect, it } from 'vitest'
import type * as C from './contract'
import json from './contract.samples.json'
import { samples } from './contract.samples'

/**
 * Every member of each union the `*_all` samples enumerate. `satisfies
 * Record<Union, true>` fails tsc on a missing or an extra member, and the
 * test below fails when a sample lists a subset, so a new member (e.g.
 * BackdropMode 'extended', v1.2) can't slip past the drift guard.
 */
const UNIONS = {
  AspectPreset: { free: true, '1:1': true, '4:3': true, '3:4': true, '4:5': true, '16:9': true, '9:16': true } satisfies Record<C.AspectPreset, true>,
  BackdropMode: { dimmed: true, blurred: true, black: true, extended: true } satisfies Record<C.BackdropMode, true>,
  CacheScope: { folder: true, all: true } satisfies Record<C.CacheScope, true>,
  CaptionPosition: {
    topLeft: true,
    topCenter: true,
    topRight: true,
    bottomLeft: true,
    bottomCenter: true,
    bottomRight: true,
  } satisfies Record<C.CaptionPosition, true>,
  DateSource: { exif: true, filename: true, fileTime: true, manual: true } satisfies Record<C.DateSource, true>,
  Easing: { linear: true, easeInOut: true } satisfies Record<C.Easing, true>,
  ErrorKind: {
    noFaceInReference: true,
    noFaceDetected: true,
    notFound: true,
    invalidArgument: true,
    unsupportedFormat: true,
    decodeFailed: true,
    permissionDenied: true,
    diskFull: true,
    io: true,
    busy: true,
    cancelled: true,
    notReady: true,
    modelUnavailable: true,
    encodeFailed: true,
    internal: true,
  } satisfies Record<C.ErrorKind, true>,
  FramesStatus: { none: true, stale: true, partial: true, complete: true } satisfies Record<C.FramesStatus, true>,
  ImageFormat: { png: true, jpeg: true } satisfies Record<C.ImageFormat, true>,
  JobKind: { scan: true, align: true, exportImages: true, exportVideo: true } satisfies Record<C.JobKind, true>,
  MatchStatus: { confirmed: true, uncertain: true, rejected: true, noFace: true, failed: true } satisfies Record<C.MatchStatus, true>,
  NormalizeMode: { off: true, exposure: true, exposureAndColor: true } satisfies Record<C.NormalizeMode, true>,
  Platform: { macos: true, windows: true, linux: true } satisfies Record<C.Platform, true>,
  Resolution: { source: true, '2160p': true, '1080p': true, '720p': true } satisfies Record<C.Resolution, true>,
  ReviewDecision: { pending: true, confirmed: true, rejected: true } satisfies Record<C.ReviewDecision, true>,
  ScanRecentStatus: { confirmed: true, uncertain: true } satisfies Record<C.ScanRecent['status'], true>,
  ScanStatus: { none: true, partial: true, complete: true } satisfies Record<C.ScanStatus, true>,
  // Object unions: compare their discriminants.
  Pace: { fps: true, duration: true } satisfies Record<C.Pace['mode'], true>,
  VideoQuality: { low: true, medium: true, high: true, max: true, bitrate: true } satisfies Record<
    Exclude<C.VideoQuality, object> | keyof Extract<C.VideoQuality, object>,
    true
  >,
}

/** The member a sample stands for: the string itself, a Pace's mode, a bitrate quality's key. */
function memberOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'mode' in value) return String((value as { mode: unknown }).mode)
  return Object.keys(value as object)[0] ?? ''
}

describe('IPC contract samples', () => {
  it('cover the same keys as the Rust-checked JSON', () => {
    expect(Object.keys(samples).sort()).toEqual(Object.keys(json).sort())
  })

  it('are deep-equal to the Rust-checked JSON', () => {
    expect(samples).toEqual(json)
  })

  it('every *_all sample lists every member of its union (no subsets)', () => {
    const listed = Object.keys(samples).filter((k) => k.endsWith('_all'))
    expect(listed.map((k) => k.replace(/_all$/, '')).sort()).toEqual(Object.keys(UNIONS).sort())
    for (const [name, members] of Object.entries(UNIONS)) {
      const sample = samples[`${name}_all` as keyof typeof samples] as unknown as unknown[]
      expect(new Set(sample.map(memberOf)), name).toEqual(new Set(Object.keys(members)))
    }
  })
})
