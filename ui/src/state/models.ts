// ui/src/state/models.ts
// Whether the face models can be used (QA: with them missing, the UI showed no
// notice at all). Contract v1.6: `AppInfo.modelsReady` true means ready, a
// `modelsError` means the startup load failed (its message says why), and
// neither means it is still loading; `models-changed` fires once when the load
// ends. App info alone decides: a command answering `modelUnavailable` can
// also mean it gave up waiting for a slow load (§7.1), so it never latches.
import { useEffect } from 'react'
import type { AppInfo, IpcError } from '../ipc/contract'
import { onModelsChanged } from '../ipc/events'
import { queryClient, queryKeys, useAppInfo } from './queries'

/** The one sentence for missing models: disabled controls' tooltips and failed commands. */
export const MODELS_MISSING = 'Face models are missing. FaceTimelapse can’t find faces until it’s reinstalled.'

/** A command that gave up waiting for the startup load (§7.1: after 2 s): nothing is wrong yet. */
export const MODELS_LOADING = 'The face models are still loading. Try again in a moment.'

export type ModelsStatus = 'ready' | 'loading' | 'missing'

type ModelsInfo = Pick<AppInfo, 'modelsReady' | 'modelsError'>

/** What the UI should assume about the models (`info` undefined before app info loads). */
export function modelsStatus(info: ModelsInfo | undefined): ModelsStatus {
  if (info?.modelsReady) return 'ready'
  if (info?.modelsError) return 'missing'
  return 'loading'
}

/**
 * A `modelUnavailable` answer reads by app info (UI review 4, M1): once the
 * load failed it is the models sentence; while the load still runs the command
 * only gave up waiting, so it says to try again. Either way app info is read
 * again, in case the load has just ended.
 */
export function withModelsNote(error: IpcError): IpcError {
  if (error.kind !== 'modelUnavailable') return error
  void queryClient.invalidateQueries({ queryKey: queryKeys.appInfo })
  const status = modelsStatus(queryClient.getQueryData<ModelsInfo>(queryKeys.appInfo))
  return { kind: error.kind, message: status === 'loading' ? MODELS_LOADING : MODELS_MISSING }
}

/** The models' status now, and the backend's reason when the load failed. */
export function useModelsInfo(): { status: ModelsStatus; error: string | null } {
  const info = useAppInfo().data
  return { status: modelsStatus(info), error: info?.modelsError ?? null }
}

/** The models' status now. */
export function useModelsStatus(): ModelsStatus {
  return useModelsInfo().status
}

/** Why a control that needs the models is off (its tooltip), or null. Nothing is off while they still load. */
export function useModelsBlock(): string | null {
  return useModelsStatus() === 'missing' ? MODELS_MISSING : null
}

/**
 * Subscribes to `models-changed`, then reads app info again (a load that ended
 * before the subscription is not missed), and re-reads it on every event.
 * Mounted once, by the app.
 */
export function useModelsWatch(): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    const reread = () => void queryClient.invalidateQueries({ queryKey: queryKeys.appInfo })
    void onModelsChanged(reread).then((stop) => {
      if (disposed) {
        stop()
        return
      }
      unlisten = stop
      reread()
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}
