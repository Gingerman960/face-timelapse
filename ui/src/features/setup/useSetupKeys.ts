import { isMod, useKeydown } from '../../hooks/useKeys'
import { isNudgeKey, type NudgeKey } from '../../lib/crop'

export interface SetupKeyActions {
  nudge: (key: NudgeKey, shift: boolean) => void
  level: () => void
  center: () => void
  reset: () => void
}

/** Reference-screen keys: arrows nudge the crop (⇧ ×10), L levels the eyes, C centres the face, R resets. */
export function useSetupKeys(enabled: boolean, actions: SetupKeyActions): void {
  useKeydown((e) => {
    if (!enabled || isMod(e) || e.altKey) return
    if (isNudgeKey(e.key)) {
      e.preventDefault()
      actions.nudge(e.key, e.shiftKey)
      return
    }
    const letter = e.key.toLowerCase()
    if (letter === 'l') actions.level()
    else if (letter === 'c') actions.center()
    else if (letter === 'r') actions.reset()
  })
}
