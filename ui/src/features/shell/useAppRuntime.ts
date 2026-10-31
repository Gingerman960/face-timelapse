import { useEffect, useRef } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isMod, runPrimaryAction, isTypingTarget } from '../../hooks/useKeys'
import { isReachable, LEDGER_ORDER, startupStep, type Step } from '../../lib/steps'
import { pickReferencePhoto, pickSourceFolder, reportError } from '../../state/actions'
import { adoptOrphanJob, cancelActiveJob, useJobs } from '../../state/jobs'
import { sessionChangedByBackend, useSession } from '../../state/queries'
import { onSessionChanged, onShowKeys } from '../../ipc/events'
import { storedLastStep, useView } from '../../state/view'
import { isKeyMapKey } from './keyMapData'
import { useKeyMap } from './keyMapStore'

/** Global shortcuts (ARCHITECTURE §8 global row + the accepted P7 additions). */
export function useAppKeys(): void {
  const session = useSession().data
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const mod = isMod(e)
      const view = useView.getState()
      const busy = useJobs.getState().activeJobId !== null
      if (mod && e.key === '.') {
        e.preventDefault()
        void cancelActiveJob()
        return
      }
      if (isTypingTarget(e.target)) return
      // ? lays the Keys card over any screen, the export sheet included (critique round 5, P2-13).
      if (isKeyMapKey(e)) {
        e.preventDefault()
        useKeyMap.getState().toggle()
        return
      }
      // A modal sheet owns the keyboard: only ⌘. (above), Escape (its layer) and its own ⌘↩
      // reach past it; ⌘↩ works even when focus has left the sheet (QA LOW).
      if (document.querySelector('[aria-modal="true"]')) {
        if (mod && e.key === 'Enter' && runPrimaryAction({ modal: true })) e.preventDefault()
        return
      }
      if (mod && e.key === 'Enter') {
        if (runPrimaryAction()) e.preventDefault()
        return
      }
      if (mod && !e.shiftKey && !e.altKey && /^[1-5]$/.test(e.key)) {
        const s = sessionRef.current
        const step = LEDGER_ORDER[Number(e.key) - 1]
        if (!s || !step) return
        e.preventDefault()
        const activeKind = useJobs.getState().activeKind
        const target: Step = step === 'timelapse' && activeKind === 'align' ? 'align' : step
        // A running job keeps its own screen open even before the cached session shows it.
        const running = (target === 'align' && activeKind === 'align') || (target === 'scan' && activeKind === 'scan')
        if (running || isReachable(target, s)) view.setStep(target)
        return
      }
      if (mod && e.key.toLowerCase() === 'o' && !busy) {
        e.preventDefault()
        const pick = e.shiftKey ? pickSourceFolder : pickReferencePhoto
        void pick()
          .then((r) => {
            if (r) view.setStep('setup')
          })
          .catch(reportError)
        return
      }
      if (e.ctrlKey && e.metaKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        view.toggleSidebar()
        return
      }
      if (e.altKey && mod && (e.key.toLowerCase() === 'i' || e.code === 'KeyI')) {
        e.preventDefault()
        view.toggleInspector()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * Keeps the visible step valid: picks the startup step once the session
 * loads, and falls back when the current step stops being reachable
 * (transient steps stay while their job runs).
 */
export function useStepRouter(): void {
  const session = useSession().data
  const step = useView((s) => s.step)
  const setStep = useView((s) => s.setStep)
  const activeKind = useJobs((s) => s.activeKind)
  const started = useRef(false)
  useEffect(() => {
    if (!session) return
    if (!started.current) {
      started.current = true
      setStep(startupStep(storedLastStep(), session))
      return
    }
    if (step === 'scan' && activeKind === 'scan') return
    if (step === 'align' && activeKind === 'align') return
    if (!isReachable(step, session)) setStep(startupStep(null, session))
  }, [session, step, activeKind, setStep])
}

/** Keeps an app event subscription while mounted (resolving late is fine: it unsubscribes at once). */
function useAppEvent(subscribe: (handler: () => void) => Promise<() => void>, handler: () => void): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    void subscribe(handler).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [subscribe, handler])
}

/** Re-reads the session whenever the backend changes it on its own (v1.2 `session-changed`). */
export function useSessionChangedEvents(): void {
  useAppEvent(onSessionChanged, sessionChangedByBackend)
}

const openKeyMap = () => useKeyMap.getState().setOpen(true)

/** Help › Keyboard Shortcuts (⌘/) in the native menu lays out the Keys card (v1.8 `show-keys`, critique round 6, P1-3). */
export function useShowKeysEvents(): void {
  useAppEvent(onShowKeys, openKeyMap)
}

/** Adopts a job the backend runs but this page didn't start (after a webview reload). */
export function useAdoptOrphanJob(): void {
  const active = useSession().data?.activeJob ?? null
  useEffect(() => {
    adoptOrphanJob(active)
  }, [active])
}

/** How long to wait for a frame before showing the window anyway. */
const SHOW_FALLBACK_MS = 50

/**
 * Resolves after the next frame, or after a short timeout: a hidden macOS
 * window never runs requestAnimationFrame (INTEGRATION-NOTES §5.3).
 */
export function nextFrameOrTimeout(ms = SHOW_FALLBACK_MS): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ])
}

/** Shows the (initially hidden) Tauri window once, after the first real render. */
export function useShowWindowWhenReady(ready: boolean): void {
  const shown = useRef(false)
  useEffect(() => {
    if (!ready || shown.current) return
    shown.current = true
    void nextFrameOrTimeout().then(async () => {
      try {
        await getCurrentWindow().show()
      } catch (err) {
        // A plain browser has no window to show; inside Tauri the shell shows it after 3 s.
        if (isTauri()) console.warn('Could not show the window.', err)
      }
    })
  }, [ready])
}
