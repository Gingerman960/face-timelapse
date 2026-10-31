import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  CommandMap,
  CommandName,
  ErrorKind,
  IpcError,
  JobCancelled,
  JobFailed,
  JobId,
} from './contract'

const ERROR_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'noFaceInReference',
  'noFaceDetected',
  'notFound',
  'invalidArgument',
  'unsupportedFormat',
  'decodeFailed',
  'permissionDenied',
  'diskFull',
  'io',
  'busy',
  'cancelled',
  'notReady',
  'modelUnavailable',
  'encodeFailed',
  'internal',
])

/** True when `value` has the exact `IpcError` shape the backend rejects with. */
export function isIpcError(value: unknown): value is IpcError {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.message === 'string' && typeof v.kind === 'string' && ERROR_KINDS.has(v.kind as ErrorKind)
}

/** Normalizes anything thrown by `invoke` into an `IpcError` (unknown throws become `internal`). */
export function toIpcError(error: unknown): IpcError {
  if (isIpcError(error)) return error
  if (error instanceof Error) return { kind: 'internal', message: error.message || 'Something went wrong.' }
  if (typeof error === 'string' && error.length > 0) return { kind: 'internal', message: error }
  return { kind: 'internal', message: 'Something went wrong.' }
}

type Args<K extends CommandName> = CommandMap[K]['args']
type Result<K extends CommandName> = CommandMap[K]['result']

/** Typed `invoke`: resolves with the command's result or rejects with an `IpcError`. */
export async function call<K extends CommandName>(
  cmd: K,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  ...args: {} extends Args<K> ? [] | [Args<K>] : [Args<K>]
): Promise<Result<K>> {
  try {
    const payload = (args[0] ?? {}) as Record<string, unknown>
    return (await invoke(cmd, payload)) as Result<K>
  } catch (error) {
    throw toIpcError(error)
  }
}

/** Any job event union from the contract: every variant carries `type` and `jobId`. */
export type JobEvent = { type: string; jobId: JobId }

type Terminal<E extends JobEvent> = Extract<E, { type: 'finished' } | { type: 'failed' } | { type: 'cancelled' }>

/** How a job ended, with the terminal event for its payload. */
export type JobOutcome<E extends JobEvent> =
  | { outcome: 'finished'; event: Extract<E, { type: 'finished' }> }
  | { outcome: 'failed'; event: Extract<E, { type: 'failed' }> & JobFailed }
  | { outcome: 'cancelled'; event: Extract<E, { type: 'cancelled' }> & JobCancelled }

export interface RunningJob<E extends JobEvent> {
  jobId: JobId
  /** Resolves on the terminal event (exactly once). */
  done: Promise<JobOutcome<E>>
}

/**
 * Starts a long job: creates the `Channel`, forwards every event to `onEvent`,
 * and resolves `done` on the terminal event. `start` rejects (with an
 * `IpcError`) when the backend refuses to start, e.g. `busy`.
 */
export async function runJob<E extends JobEvent>(
  start: (channel: Channel<E>) => Promise<JobId>,
  onEvent: (event: E) => void,
): Promise<RunningJob<E>> {
  let settle: (value: JobOutcome<E>) => void = () => undefined
  const done = new Promise<JobOutcome<E>>((resolve) => {
    settle = resolve
  })
  let ended = false
  const channel = new Channel<E>()
  channel.onmessage = (event) => {
    if (ended) return
    onEvent(event)
    if (isTerminal(event)) {
      ended = true
      settle({ outcome: event.type, event } as JobOutcome<E>)
    }
  }
  try {
    const jobId = await start(channel)
    return { jobId, done }
  } catch (error) {
    throw toIpcError(error)
  }
}

function isTerminal<E extends JobEvent>(event: E): event is Terminal<E> {
  return event.type === 'finished' || event.type === 'failed' || event.type === 'cancelled'
}
