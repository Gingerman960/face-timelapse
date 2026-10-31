// App events the shell emits outside command replies (ARCHITECTURE §7.4).
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * v1.2 `SESSION_CHANGED_EVENT` (no payload): the backend changed the session
 * on its own (dev autoload; a stale restored reference re-analyzed once the
 * models load). Re-read the session and everything derived from it.
 */
export const SESSION_CHANGED_EVENT = 'session-changed'

/**
 * v1.6 `MODELS_CHANGED_EVENT` (no payload): the startup model load ended,
 * successfully or not, once per run. Subscribe first, then read `get_app_info`
 * (`modelsReady`, `modelsError`) so a load that ended earlier is not missed.
 */
export const MODELS_CHANGED_EVENT = 'models-changed'

/**
 * v1.8 `SHOW_KEYS_EVENT` (no payload): Help › Keyboard Shortcuts (⌘/) was
 * chosen in the native menu. Lay the Keys card over the current screen.
 */
export const SHOW_KEYS_EVENT = 'show-keys'

/**
 * Subscribes to `session-changed`. Resolves to an unlisten function; outside
 * Tauri (and without the mock) there is nothing to listen to, so it resolves
 * to a no-op instead of throwing.
 */
export async function onSessionChanged(handler: () => void): Promise<UnlistenFn> {
  try {
    return await listen(SESSION_CHANGED_EVENT, () => handler())
  } catch {
    return () => undefined
  }
}

/**
 * Subscribes to `models-changed` (v1.6). Resolves to an unlisten function, or
 * to a no-op where there is nothing to listen to (outside Tauri, no mock).
 */
export async function onModelsChanged(handler: () => void): Promise<UnlistenFn> {
  try {
    return await listen(MODELS_CHANGED_EVENT, () => handler())
  } catch {
    return () => undefined
  }
}

/**
 * Subscribes to `show-keys` (v1.8). Resolves to an unlisten function, or to a
 * no-op where there is nothing to listen to (outside Tauri, no mock).
 */
export async function onShowKeys(handler: () => void): Promise<UnlistenFn> {
  try {
    return await listen(SHOW_KEYS_EVENT, () => handler())
  } catch {
    return () => undefined
  }
}
