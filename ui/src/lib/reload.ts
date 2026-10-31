/** Reloads the window (the crash panel's way out). Its own module so tests can stand in for it. */
export function reloadWindow(): void {
  window.location.reload()
}
