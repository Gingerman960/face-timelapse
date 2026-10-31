import { useCallback } from 'react'
import { abbreviatePath, homeFromDataDir, PATH_DISPLAY_MAX } from '../lib/paths'
import { useCachedAppInfo } from '../state/queries'

/**
 * Returns `show(path)`: the path as the UI displays it ("~/…" and a
 * middle-truncated tail). Put the full path in a `title` next to it; never
 * send the shortened one anywhere.
 *
 * Reads the app info the shell already loaded (never fetches on its own), and
 * works outside a QueryClientProvider, so leaf components stay testable.
 */
export function usePathDisplay(): (path: string, max?: number) => string {
  const info = useCachedAppInfo().data
  const home = homeFromDataDir(info?.dataDir)
  return useCallback((path: string, max: number = PATH_DISPLAY_MAX) => abbreviatePath(path, home, max), [home])
}
