import { describe, expect, it } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { Channel } from '@tauri-apps/api/core'
import { call, isIpcError, runJob, toIpcError } from './client'
import type { ScanEvent } from './contract'

describe('error narrowing', () => {
  it('recognizes the contract IpcError shape only', () => {
    expect(isIpcError({ kind: 'busy', message: 'x' })).toBe(true)
    expect(isIpcError({ kind: 'nope', message: 'x' })).toBe(false)
    expect(isIpcError({ kind: 'busy' })).toBe(false)
    expect(isIpcError(null)).toBe(false)
    expect(isIpcError('busy')).toBe(false)
  })
  it('normalizes unknown throws to internal', () => {
    expect(toIpcError({ kind: 'notFound', message: 'gone' })).toEqual({ kind: 'notFound', message: 'gone' })
    expect(toIpcError(new Error('boom'))).toEqual({ kind: 'internal', message: 'boom' })
    expect(toIpcError(new Error(''))).toEqual({ kind: 'internal', message: 'Something went wrong.' })
    expect(toIpcError('plain')).toEqual({ kind: 'internal', message: 'plain' })
    expect(toIpcError(42)).toEqual({ kind: 'internal', message: 'Something went wrong.' })
  })
})

describe('call', () => {
  it('passes args through and returns the result', async () => {
    mockIPC((cmd, args) => (cmd === 'set_source_folder' ? { echoed: (args as { path: string }).path } : null))
    await expect(call('set_source_folder', { path: '/x' })).resolves.toEqual({ echoed: '/x' })
    await expect(call('get_session')).resolves.toBeNull()
  })
  it('rejects with an IpcError', async () => {
    mockIPC(() => {
      throw { kind: 'busy', message: 'Another task is running.' }
    })
    await expect(call('get_session')).rejects.toEqual({ kind: 'busy', message: 'Another task is running.' })
    mockIPC(() => {
      throw new Error('kaput')
    })
    await expect(call('get_session')).rejects.toEqual({ kind: 'internal', message: 'kaput' })
  })
})

describe('runJob', () => {
  it('forwards events and resolves once on the terminal event', async () => {
    mockIPC((cmd, args) => {
      if (cmd !== 'start_scan') return null
      const ch = (args as { onEvent: Channel<ScanEvent> }).onEvent
      queueMicrotask(() => {
        ch.onmessage({ type: 'started', jobId: 'j1', total: 2 })
        ch.onmessage({ type: 'finished', jobId: 'j1', total: 2, fromCache: 0, analyzed: 2, confirmed: 2, uncertain: 0, rejected: 0, noFace: 0, failed: 0, durationMs: 5 })
        ch.onmessage({ type: 'cancelled', jobId: 'j1', done: 0 })
      })
      return 'j1'
    })
    const seen: string[] = []
    const job = await runJob<ScanEvent>((onEvent) => call('start_scan', { onEvent }), (e) => seen.push(e.type))
    expect(job.jobId).toBe('j1')
    const r = await job.done
    expect(r.outcome).toBe('finished')
    expect(seen).toEqual(['started', 'finished'])
  })
  it('rejects when the job cannot start', async () => {
    mockIPC(() => {
      throw { kind: 'notReady', message: 'Choose a source folder first.' }
    })
    await expect(runJob<ScanEvent>((onEvent) => call('start_scan', { onEvent }), () => undefined)).rejects.toMatchObject({ kind: 'notReady' })
  })
})
