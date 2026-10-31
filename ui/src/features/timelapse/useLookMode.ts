import { useEffect } from 'react'
import type { NormalizeMode } from '../../ipc/contract'
import { usePlayer, type LookMode } from '../../state/player'

/**
 * The Even light mode to switch on: the current one when the look is on,
 * else the one last used (shared by the player and the export sheet).
 */
export function useLookMode(normalize: NormalizeMode): LookMode {
  const remembered = usePlayer((s) => s.lookMode)
  useEffect(() => {
    if (normalize !== 'off') usePlayer.getState().setLookMode(normalize)
  }, [normalize])
  return normalize === 'off' ? remembered : normalize
}
