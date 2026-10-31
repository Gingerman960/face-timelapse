// The first photo lands (signature moment 6): when a reference arrives on
// screen — the first one, or a new pick — the print develops in, the template
// draws itself over it and "Face found" is ticked. Coming back to an unchanged
// reference, or opening the app on one, is not an arrival.
import { useEffect, useState } from 'react'

/** The reference version last on screen this run: undefined before any, null while there was none. */
let seen: string | null | undefined

/** True while `version` is a reference that has just arrived on screen. */
export function useArrival(version: string | null): boolean {
  const [state, setState] = useState(() => ({ version, arrived: seen !== undefined && version !== null && seen !== version }))
  if (state.version !== version) setState({ version, arrived: version !== null })
  useEffect(() => {
    seen = version
  }, [version])
  return state.arrived && state.version === version
}

/** Forgets what was on screen (tests). */
export function resetArrival(): void {
  seen = undefined
}
