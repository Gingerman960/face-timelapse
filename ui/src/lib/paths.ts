// ui/src/lib/paths.ts
// Showing paths without showing too much (QA 29): the home folder becomes "~"
// and long paths lose their middle. Display only; the real path is passed to
// the backend untouched (contract v1.3 path grants) and shown in a tooltip.

/** Where the per-user app data lives under the home folder, per platform. */
const DATA_DIR_MARKERS = ['/Library/', '\\AppData\\', '/.local/', '/.config/']

/** The home folder, derived from `AppInfo.dataDir`; null when it can't be told. */
export function homeFromDataDir(dataDir: string | null | undefined): string | null {
  if (!dataDir) return null
  for (const marker of DATA_DIR_MARKERS) {
    const i = dataDir.indexOf(marker)
    if (i > 0) return dataDir.slice(0, i)
  }
  return null
}

/** Default width of an abbreviated path, in characters. */
export const PATH_DISPLAY_MAX = 40

/**
 * "~/Pictures/Daily selfies"; a long path keeps its first folder and its last
 * two ("~/Projects/…/everyday photos/photos"), and falls back to "…/<last>".
 */
export function abbreviatePath(path: string, home: string | null, max = PATH_DISPLAY_MAX): string {
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const atHome = home !== null && (path === home || path.startsWith(home + sep))
  const shown = atHome ? `~${path.slice(home.length)}` : path
  if (shown.length <= max) return shown
  const parts = shown.split(sep)
  // The root (or ~, or a drive) plus the first folder: "/Volumes", "~/Projects", "C:\\Users".
  const head = parts.slice(0, 2).join(sep)
  const tail2 = parts.slice(-2).join(sep)
  const candidate = `${head}${sep}…${sep}${tail2}`
  if (candidate.length <= max && parts.length > 4) return candidate
  return `…${sep}${parts[parts.length - 1] ?? shown}`
}
