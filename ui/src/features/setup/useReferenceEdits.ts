import type { AspectPreset, Rect, ReferenceState } from '../../ipc/contract'
import { toIpcError } from '../../ipc/client'
import { centerFaceCrop, defaultCrop, nudgeCrop, reshapeToAspect, type NudgeKey } from '../../lib/crop'
import { clearScanCache, reportError, setReferenceRotation } from '../../state/actions'
import { withModelsNote } from '../../state/models'
import { levelRotation } from './setupModel'
import type { CropDraft } from './useCropDraft'

/** Crop and rotation edits; failures land in the draft's inline error. */
export function useReferenceEdits(ref: ReferenceState | null, crop: Rect | null, draft: CropDraft) {
  const run = (p: Promise<unknown>) =>
    void p.then(
      () => draft.setError(null),
      (e: unknown) => draft.setError(withModelsNote(toIpcError(e))),
    )
  return {
    run,
    nudge: (key: NudgeKey, shift: boolean) => {
      // From the newest draft, even one a commit in flight hasn't confirmed yet (H2).
      const base = draft.latest() ?? crop
      if (ref && base) draft.schedule(nudgeCrop(base, key, shift, ref.image.size))
    },
    level: () => {
      const rotation = ref ? levelRotation(ref.image) : null
      if (rotation === null) return
      // The backend carries the crop through the rotation (`reference::rotate_crop`),
      // so a pending nudge is committed first, on the canvas it was measured on.
      void draft.flush().then((committed) => {
        if (committed) run(setReferenceRotation(rotation))
      })
    },
    center: () => {
      if (ref && crop && ref.image.face) void draft.commit(centerFaceCrop(crop, ref.image.face.bounds, ref.image.size, ref.aspect), ref.aspect)
    },
    reset: () => {
      if (ref) void draft.commit(defaultCrop(ref.image.size, ref.aspect), ref.aspect)
    },
    changeAspect: (aspect: AspectPreset) => {
      if (ref && crop) void draft.commit(reshapeToAspect(crop, ref.image.size, aspect), aspect)
    },
  }
}

/** Forgets the current folder's scan results (decisions stay); a refusal is a toast. */
export async function forgetScanResults(): Promise<void> {
  try {
    await clearScanCache('folder')
  } catch (e) {
    reportError(e)
  }
}
