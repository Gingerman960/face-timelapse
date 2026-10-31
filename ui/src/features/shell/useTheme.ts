import { useEffect, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useView } from '../../state/view'

/**
 * Mirrors the chosen theme onto <html data-theme> ("system" removes it so CSS
 * follows the OS) and, inside Tauri, onto the native window (v1.2
 * `allow-set-theme`) so the title bar and the sidebar material follow an
 * explicit choice. `data-native-theme` marks a confirmed native match; only
 * then may the sidebar stay translucent under an explicit theme (shell.css).
 */
export function useApplyTheme(): void {
  const theme = useView((s) => s.theme)
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
    delete root.dataset.nativeTheme
    if (!isTauri()) return
    let current = true
    getCurrentWindow()
      .setTheme(theme === 'system' ? null : theme)
      .then(() => {
        if (current && theme !== 'system') root.dataset.nativeTheme = theme
      })
      .catch((err: unknown) => console.warn('The window theme could not follow the app theme.', err))
    return () => {
      current = false
    }
  }, [theme])
}

/**
 * A counter that changes whenever the effective palette may have changed
 * (theme choice or OS appearance), so canvases know to redraw.
 */
export function useThemeVersion(): number {
  const theme = useView((s) => s.theme)
  const [osVersion, setOsVersion] = useState(0)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const bump = () => setOsVersion((v) => v + 1)
    mq.addEventListener('change', bump)
    return () => mq.removeEventListener('change', bump)
  }, [])
  return osVersion * 3 + (theme === 'system' ? 0 : theme === 'light' ? 1 : 2)
}

/** True when the window is at most `px` wide (live). */
export function useMaxWidth(px: number): boolean {
  const query = `(max-width: ${px}px)`
  const [match, setMatch] = useState(() => window.matchMedia?.(query).matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const on = () => setMatch(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}
