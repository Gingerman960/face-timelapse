import { useEffect, useRef } from 'react'

/** True when a key event comes from a text field, so shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'range', 'button', 'submit'].includes(target.type)
  }
  return false
}

const ACTIVATABLE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="option"], [role="radio"], [role="switch"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="gridcell"]'

/**
 * True when the focused element handles Enter/Space itself (activating a
 * button, selecting an option…), so a screen shortcut on those keys must
 * stand back.
 */
export function isActivationTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ACTIVATABLE) !== null
}

/** ⌘ on macOS, Ctrl elsewhere. */
export function isMod(e: KeyboardEvent | { metaKey: boolean; ctrlKey: boolean }): boolean {
  return navigator.platform.toLowerCase().includes('mac') ? e.metaKey : e.ctrlKey || e.metaKey
}

/**
 * True for a focused form control of any kind (a range uses arrows, a
 * checkbox uses Space) or anything inside a popover: they handle their own
 * keys, so screen shortcuts stand back.
 */
export function ownsItsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest('input, select, textarea, .popover') !== null
}

/**
 * Window keydown listener scoped to the mounted screen. Ignores typing
 * targets, already-handled events and (unless `inModal`) events while a
 * modal sheet is open. The latest handler is always used (no re-subscribe).
 */
export function useKeydown(handler: (e: KeyboardEvent) => void, enabled = true): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    if (!enabled) return
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || ownsItsKeys(e.target)) return
      if (document.querySelector('[aria-modal="true"]')) return
      ref.current(e)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [enabled])
}

type Action = (() => void) | null

interface Registration {
  run: () => void
  /** Registered by a modal sheet: the only kind ⌘↩ reaches while a sheet is open. */
  modal: boolean
}

/** Mounted primary actions, newest last: a sheet over a screen takes ⌘↩ until it closes. */
const registrations: Registration[] = []

/**
 * Registers a primary action (⌘↩) while mounted. Registrations stack, so a
 * sheet opened over a screen takes ⌘↩ while it is open and the screen gets it
 * back when it closes. A sheet passes `modal` so ⌘↩ reaches it from anywhere
 * while it is open, even when focus has left it.
 */
export function usePrimaryAction(action: Action, { modal = false }: { modal?: boolean } = {}): void {
  const ref = useRef(action)
  useEffect(() => {
    ref.current = action
  })
  useEffect(() => {
    const entry: Registration = { run: () => ref.current?.(), modal }
    registrations.push(entry)
    return () => {
      const at = registrations.indexOf(entry)
      if (at >= 0) registrations.splice(at, 1)
    }
  }, [modal])
}

/**
 * Runs the newest registered primary action, if any. While a modal sheet is
 * open (`modal`), only a sheet's own action runs, never the screen's under it.
 */
export function runPrimaryAction({ modal = false }: { modal?: boolean } = {}): boolean {
  const top = registrations.at(-1)
  if (!top || (modal && !top.modal)) return false
  top.run()
  return true
}
