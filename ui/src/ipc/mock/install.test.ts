import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppInfo, ScanEvent } from '../contract'
import { DEMO_FOLDER, REFERENCE_PATH } from './fixtures'
import { installMockBackend } from './install'
import { MODELS_CHANGED_EVENT } from '../events'

afterEach(() => {
  window.history.replaceState({}, '', '/')
  delete window.__FT_MOCK__
})

describe('installMockBackend', () => {
  it('routes invoke to the fake backend and exposes it on window.__FT_MOCK__', async () => {
    const backend = installMockBackend({ scenario: 'ready', speed: 'instant' })
    expect(window.__FT_MOCK__?.backend).toBe(backend)
    const info = await invoke<AppInfo>('get_app_info')
    expect(info.imageBaseUrl).toBe('/__mock/img/')
    await expect(invoke('set_source_folder', { path: '/Users/demo/Nope' })).rejects.toEqual({
      kind: 'notFound',
      message: 'This file is no longer there: /Users/demo/Nope',
    })
  })

  it('delivers job events through a real Tauri Channel', async () => {
    installMockBackend({ scenario: 'ready', speed: 'instant' })
    const events: ScanEvent[] = []
    const done = new Promise<void>((resolve) => {
      const channel = new Channel<ScanEvent>()
      channel.onmessage = (event) => {
        events.push(event)
        if (event.type === 'finished' || event.type === 'failed' || event.type === 'cancelled') resolve()
      }
      void invoke<string>('start_scan', { onEvent: channel })
    })
    await done
    expect(events[0]?.type).toBe('started')
    expect(events.at(-1)?.type).toBe('finished')
  })

  it('mocks the window and webview plugins', async () => {
    installMockBackend({ scenario: 'fresh', speed: 'instant' })
    expect(getCurrentWindow().label).toBe('main')
    await expect(getCurrentWindow().show()).resolves.toBeNull()
    expect(getCurrentWebview().label).toBe('main')
  })

  it('emits OS drag-and-drop events for the webview', async () => {
    installMockBackend({ scenario: 'fresh', speed: 'instant' })
    const seen: { type: string; paths?: string[] }[] = []
    const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload
      seen.push(p.type === 'enter' || p.type === 'drop' ? { type: p.type, paths: p.paths } : { type: p.type })
    })
    const api = window.__FT_MOCK__!
    await api.emitDragEnter([REFERENCE_PATH])
    await api.emitDragDrop([REFERENCE_PATH, DEMO_FOLDER], { x: 10, y: 20 })
    await api.emitDragLeave()
    expect(seen).toEqual([
      { type: 'enter', paths: [REFERENCE_PATH] },
      { type: 'over' },
      { type: 'drop', paths: [REFERENCE_PATH, DEMO_FOLDER] },
      { type: 'leave' },
    ])
    unlisten()
  })

  it('reports ready models with no error by default (v1.6)', async () => {
    installMockBackend({ scenario: 'ready', speed: 'instant' })
    expect(await invoke<AppInfo>('get_app_info')).toMatchObject({ modelsReady: true, modelsError: null })
  })

  it('models=missing reports the failure message and emits models-changed after install (v1.6)', async () => {
    installMockBackend({ scenario: 'ready', speed: 'instant', modelsMissing: true })
    const heard = new Promise<unknown>((resolve) => {
      void listen(MODELS_CHANGED_EVENT, (event) => resolve(event.payload))
    })
    expect(await invoke<AppInfo>('get_app_info')).toMatchObject({
      modelsReady: false,
      modelsError: "The face models couldn't be loaded. Reinstall FaceTimelapse.",
    })
    await expect(heard).resolves.toBeNull()
  })

  it('emits models-changed on demand for tests (v1.6)', async () => {
    installMockBackend({ scenario: 'ready', speed: 'instant' })
    let count = 0
    const unlisten = await listen(MODELS_CHANGED_EVENT, () => {
      count += 1
    })
    await window.__FT_MOCK__!.emitModelsChanged()
    expect(count).toBe(1)
    unlisten()
  })

  it('reads options from location.search when called without arguments', async () => {
    window.history.replaceState({}, '', '/?mock=scanned&speed=fast&fail=start_scan:permissionDenied&dialogs=cancel')
    const backend = installMockBackend()
    expect(backend.settings).toMatchObject({ scenario: 'scanned', speed: 'fast', cancelDialogs: true })
    expect(backend.settings.fail).toEqual({ start_scan: 'permissionDenied' })
    window.history.replaceState({}, '', '/')
    expect(installMockBackend().settings).toMatchObject({ scenario: 'aligned', speed: 'normal' })
  })
})
