// Installs the in-memory fake backend behind `invoke` (dev without Tauri,
// Vitest, Playwright). `src/main.tsx` calls `installMockBackend()` when
// VITE_FT_MOCK is set; options then come from the URL:
//   ?mock=<fresh|ready|scanned|reviewed|aligned>&speed=<instant|fast|normal>
//   &fail=<command|scanMidway|alignMidway|exportImagesMidway|exportVideoMidway>:<ErrorKind>,...
//   &dialogs=cancel&alignFailures=<n>&grants=off&models=missing
import { emit } from '@tauri-apps/api/event'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import type { Point } from '../contract'
import { FakeBackend } from './fakeBackend'
import { type MockOptions, parseMockOptions, resolveMockOptions } from './options'
import { MODELS_CHANGED_EVENT, SESSION_CHANGED_EVENT, SHOW_KEYS_EVENT } from '../events'

export type { MockOptions, MockScenario, MockSpeed, MockFailPoint } from './options'
export { FakeBackend } from './fakeBackend'

/** Test hooks exposed on `window.__FT_MOCK__`. */
export interface FtMockApi {
  backend: FakeBackend
  /** Emits `tauri://drag-drop` (what the OS sends when files are dropped on the window). */
  emitDragDrop(paths: string[], position?: Point): Promise<void>
  /** Emits `tauri://drag-enter` then `tauri://drag-over`. */
  emitDragEnter(paths: string[], position?: Point): Promise<void>
  /** Emits `tauri://drag-leave`. */
  emitDragLeave(): Promise<void>
  /** The backend changed the session on its own (v1.2 `session-changed`, no payload). */
  emitSessionChanged(): Promise<void>
  /** The startup model load ended (v1.6 `models-changed`, no payload). */
  emitModelsChanged(): Promise<void>
  /** Help › Keyboard Shortcuts was chosen in the native menu (v1.8 `show-keys`, no payload). */
  emitShowKeys(): Promise<void>
}

declare global {
  interface Window {
    __FT_MOCK__?: FtMockApi
  }
}

function centre(): Point {
  const ratio = window.devicePixelRatio || 1
  return { x: Math.round((window.innerWidth / 2) * ratio), y: Math.round((window.innerHeight / 2) * ratio) }
}

export function createDragDropApi(backend?: FakeBackend): Omit<FtMockApi, 'backend'> {
  return {
    // The shell records a drop's paths as granted before the page hears about the drop (v1.3).
    emitDragDrop: (paths, position = centre()) => {
      backend?.grant(paths)
      return emit('tauri://drag-drop', { paths, position })
    },
    emitDragEnter: async (paths, position = centre()) => {
      await emit('tauri://drag-enter', { paths, position })
      await emit('tauri://drag-over', { position })
    },
    emitDragLeave: () => emit('tauri://drag-leave', null),
    emitSessionChanged: () => emit(SESSION_CHANGED_EVENT, null),
    emitModelsChanged: () => emit(MODELS_CHANGED_EVENT, null),
    emitShowKeys: () => emit(SHOW_KEYS_EVENT, null),
  }
}

/**
 * Creates a FakeBackend and routes every `invoke` to it. Without `opts`, the
 * options are parsed from `location.search` (defaults: scenario `aligned`,
 * speed `normal`); with `opts`, the URL is ignored (Vitest).
 */
export function installMockBackend(opts?: Partial<MockOptions>): FakeBackend {
  const options = opts ? resolveMockOptions(opts) : parseMockOptions(window.location.search)
  const backend = new FakeBackend(options)
  mockWindows('main')
  mockIPC((cmd, payload) => backend.handle(cmd, payload), { shouldMockEvents: true })
  const api = createDragDropApi(backend)
  window.__FT_MOCK__ = { backend, ...api }
  // The shell emits `models-changed` once its startup load ends (v1.6). The mock's
  // outcome is readable from the start, so only the failure is announced, a tick later.
  if (options.modelsMissing) setTimeout(() => void api.emitModelsChanged().catch(() => undefined), 0)
  return backend
}
