import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useView } from '../../state/view'
import type { OnionSettings } from './Player'

/** Onion skin settings from the view store (one stable object while unchanged) and a patch setter. */
export function useOnion(): [OnionSettings, (patch: Partial<OnionSettings>) => void] {
  const onion = useView(
    useShallow((s): OnionSettings => ({ on: s.onion, source: s.onionSource, opacity: s.onionOpacity, difference: s.onionDifference })),
  )
  const setOnion = useCallback((patch: Partial<OnionSettings>) => {
    const v = useView.getState()
    v.setOnion({
      onion: patch.on ?? v.onion,
      onionSource: patch.source ?? v.onionSource,
      onionOpacity: patch.opacity ?? v.onionOpacity,
      onionDifference: patch.difference ?? v.onionDifference,
    })
  }, [])
  return [onion, setOnion]
}
