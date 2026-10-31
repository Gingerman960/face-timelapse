// Options of the in-memory mock backend and their URL encoding:
//   ?mock=<scenario>&speed=<speed>&fail=<point:kind,...>&dialogs=cancel&alignFailures=<n>&grants=off&models=missing|loading
import type { CommandName, ErrorKind } from '../contract'
import { isErrorKind } from './errors'

export const MOCK_SCENARIOS = ['fresh', 'ready', 'scanned', 'reviewed', 'aligned'] as const
export type MockScenario = (typeof MOCK_SCENARIOS)[number]

export const MOCK_SPEEDS = ['instant', 'fast', 'normal'] as const
export type MockSpeed = (typeof MOCK_SPEEDS)[number]

/** Mid-job failure points: the job emits `failed` about halfway through. */
export const MIDWAY_FAIL_POINTS = ['scanMidway', 'alignMidway', 'exportImagesMidway', 'exportVideoMidway'] as const
export type MidwayFailPoint = (typeof MIDWAY_FAIL_POINTS)[number]

/** A command name rejects at call time; a midway point fails the running job. */
export type MockFailPoint = CommandName | MidwayFailPoint

export interface MockOptions {
  /** Initial session. */
  scenario: MockScenario
  /** Job timing: `instant` (< 50 ms, Vitest), `fast` (~1 s, Playwright), `normal` (~5–8 s, dev). */
  speed: MockSpeed
  /** Failure injection, e.g. `{ start_scan: 'modelUnavailable', scanMidway: 'diskFull' }`. */
  fail: Partial<Record<MockFailPoint, ErrorKind>>
  /** When true every `pick_*` dialog (and `add_photo_to_day` with a null path) is "cancelled" (null). */
  cancelDialogs: boolean
  /** Photos that fail to align in each align job (AlignSummary.failed). */
  alignFailures: number
  /**
   * Contract v1.3 path grants: refuse (`permissionDenied`) any path that didn't
   * come from a dialog, a drop or the session's own paths, compared byte for
   * byte. On by default in the browser (dev, Playwright), off for Vitest
   * calls that pass literal paths.
   */
  strictGrants: boolean
  /**
   * The face models couldn't be loaded (QA): `get_app_info` says `modelsReady:
   * false` with the failure in `modelsError` (v1.6), `models-changed` is
   * emitted once after install, and every command that needs them (scan,
   * align, adding a photo, a frame nudge) fails with `modelUnavailable`.
   */
  modelsMissing: boolean
  /**
   * The startup model load hasn't ended yet (v1.6): `modelsReady: false` with
   * `modelsError: null`. Tests end it with `configure` and `emitModelsChanged`.
   * Commands that need the models answer `modelUnavailable` meanwhile, as the
   * backend does once a load outlasts its 2 s wait (§7.1).
   */
  modelsLoading: boolean
}

export const DEFAULT_MOCK_OPTIONS: MockOptions = {
  scenario: 'aligned',
  speed: 'normal',
  fail: {},
  cancelDialogs: false,
  alignFailures: 3,
  strictGrants: false,
  modelsMissing: false,
  modelsLoading: false,
}

const COMMAND_NAMES: readonly CommandName[] = [
  'get_app_info',
  'get_session',
  'reset_session',
  'pick_reference_photo',
  'set_reference_photo',
  'set_reference_rotation',
  'set_reference_crop',
  'pick_source_folder',
  'set_source_folder',
  'clear_scan_cache',
  'start_scan',
  'cancel_job',
  'get_photos',
  'get_photo',
  'set_review_decision',
  'get_days',
  'select_day_photo',
  'move_photo_to_day',
  'add_photo_to_day',
  'set_day_excluded',
  'start_align',
  'get_frames',
  'set_frame_adjustment',
  'set_look',
  'pick_export_folder',
  'start_export_images',
  'pick_video_path',
  'start_export_video',
  'reveal_path',
  'set_video_settings',
  'open_path',
]

export const ALL_COMMANDS: readonly CommandName[] = COMMAND_NAMES

export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value)
}

export function isFailPoint(value: string): value is MockFailPoint {
  return isCommandName(value) || (MIDWAY_FAIL_POINTS as readonly string[]).includes(value)
}

function oneOf<T extends string>(values: readonly T[], raw: string | null, fallback: T): T {
  return raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : fallback
}

/** Parses `fail=start_scan:busy,scanMidway:diskFull`; unknown entries are ignored with a warning. */
export function parseFailures(raw: string | null): Partial<Record<MockFailPoint, ErrorKind>> {
  if (!raw) return {}
  return Object.fromEntries(
    raw
      .split(',')
      .map((entry) => entry.trim().split(':'))
      .filter(([point, kind]) => {
        const ok = point !== undefined && kind !== undefined && isFailPoint(point) && isErrorKind(kind)
        if (!ok) console.warn(`[mock] ignoring fail entry "${[point, kind].join(':')}"`)
        return ok
      }),
  ) as Partial<Record<MockFailPoint, ErrorKind>>
}

/** Options from a query string such as `?mock=reviewed&speed=fast`. Missing values use the defaults. */
export function parseMockOptions(search: string): MockOptions {
  const params = new URLSearchParams(search)
  const failures = params.get('alignFailures')
  const alignFailures = failures !== null && /^\d{1,2}$/.test(failures) ? Number(failures) : undefined
  return {
    scenario: oneOf(MOCK_SCENARIOS, params.get('mock'), DEFAULT_MOCK_OPTIONS.scenario),
    speed: oneOf(MOCK_SPEEDS, params.get('speed'), DEFAULT_MOCK_OPTIONS.speed),
    fail: parseFailures(params.get('fail')),
    cancelDialogs: params.get('dialogs') === 'cancel',
    alignFailures: alignFailures ?? DEFAULT_MOCK_OPTIONS.alignFailures,
    strictGrants: params.get('grants') !== 'off',
    modelsMissing: params.get('models') === 'missing',
    modelsLoading: params.get('models') === 'loading',
  }
}

/** Full options from a partial override. */
export function resolveMockOptions(partial: Partial<MockOptions> = {}): MockOptions {
  return { ...DEFAULT_MOCK_OPTIONS, ...partial, fail: { ...(partial.fail ?? {}) } }
}
