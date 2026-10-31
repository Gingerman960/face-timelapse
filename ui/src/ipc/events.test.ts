// The app events resolve to a no-op outside Tauri (no mock), so the app runs in a plain browser.
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.reject(new Error('not in Tauri'))) }))
const { onModelsChanged, onSessionChanged, onShowKeys } = await import('./events')

describe('app event subscriptions without Tauri', () => {
  it('resolve to a no-op unlisten instead of throwing', async () => {
    const session = await onSessionChanged(() => undefined)
    const models = await onModelsChanged(() => undefined)
    const keys = await onShowKeys(() => undefined)
    expect(session()).toBeUndefined()
    expect(models()).toBeUndefined()
    expect(keys()).toBeUndefined()
  })
})
