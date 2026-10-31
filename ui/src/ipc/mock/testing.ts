// Helpers for tests that drive the fake backend directly (no Tauri Channel needed).
import type { Channel } from '@tauri-apps/api/core'
import { expect } from 'vitest'
import type { ErrorKind } from '../contract'

export interface JobEventLike {
  type: string
}

export interface JobRecorder<E extends JobEventLike> {
  /** Every event received so far, in order. */
  readonly events: readonly E[]
  /** Pass as `onEvent` (typed as the contract's Channel). */
  readonly channel: Channel<E>
  /** Resolves with all events once a terminal event arrives. */
  readonly done: Promise<E[]>
}

const TERMINAL = new Set(['finished', 'failed', 'cancelled'])

/** Records a job's events; `onEvent` runs synchronously for each one (e.g. to cancel mid-job). */
export function recordJob<E extends JobEventLike>(onEvent?: (event: E, index: number) => void): JobRecorder<E> {
  const events: E[] = []
  let resolve: (all: E[]) => void = () => undefined
  const done = new Promise<E[]>((r) => {
    resolve = r
  })
  const sink = {
    onmessage: (event: E) => {
      events.push(event)
      onEvent?.(event, events.length - 1)
      if (TERMINAL.has(event.type)) resolve(events.slice())
    },
  }
  return { events, channel: sink as unknown as Channel<E>, done }
}

/** Awaits a rejection and asserts it is exactly an `IpcError` of `kind` (optionally matching `message`). */
export async function expectIpcError(promise: Promise<unknown>, kind: ErrorKind, message?: string | RegExp): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error(`expected a ${kind} rejection`)
    },
    (e: unknown) => e,
  )
  expect(error).toMatchObject({ kind })
  expect(Object.keys(error as object).sort()).toEqual(['kind', 'message'])
  if (message !== undefined) expect((error as { message: string }).message).toMatch(message)
}
