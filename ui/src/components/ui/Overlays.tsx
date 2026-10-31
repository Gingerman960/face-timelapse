import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Warning, WarningCircle, X } from '@phosphor-icons/react'
import { useView, type Toast } from '../../state/view'
import { useExit, usePresence, usePresenceList } from './presence'
import './overlays.css'

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
}

/* Escape closes only the top-most layer (a popover over the export sheet
   closes the popover, not the sheet). Layers register in opening order. */
type EscapeLayer = { readonly handle: () => void }
let escapeLayers: readonly EscapeLayer[] = []

function onEscapeKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // A field with an unsaved edit takes the first Escape to revert itself.
  if (e.target instanceof HTMLElement && e.target.dataset.dirty === 'true') return
  const top = escapeLayers[escapeLayers.length - 1]
  if (!top) return
  e.stopPropagation()
  e.preventDefault()
  top.handle()
}

/** Registers `handler` as an Escape layer while `active`; only the newest layer runs. */
export function useEscapeLayer(active: boolean, handler: () => void): void {
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  useEffect(() => {
    if (!active) return
    const layer: EscapeLayer = { handle: () => latest.current() }
    if (escapeLayers.length === 0) window.addEventListener('keydown', onEscapeKey, true)
    escapeLayers = [...escapeLayers, layer]
    return () => {
      escapeLayers = escapeLayers.filter((l) => l !== layer)
      if (escapeLayers.length === 0) window.removeEventListener('keydown', onEscapeKey, true)
    }
  }, [active])
}

interface PopoverProps {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  labelledBy: string
  placement?: 'below-end' | 'above-start' | 'above-center'
  width?: number
  children: ReactNode
}

/**
 * An anchored dialog (portal, fixed position). Escape or a click outside
 * closes it; focus moves in on open and back to the anchor on close. A
 * closed popover fades out (100 ms) as an inert copy: focus, Escape and
 * clicks have already moved on.
 */
export function Popover({ anchor, open, onClose, labelledBy, placement = 'below-end', width = 320, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const { mounted, leaving, done } = usePresence(open)
  useExit(leaving, [{ ref, kind: 'popover' }], done)

  useLayoutEffect(() => {
    if (!open) return
    const a = anchor.current?.getBoundingClientRect()
    const h = ref.current?.offsetHeight ?? 0
    if (!a) return
    const margin = 8
    const left =
      placement === 'below-end' ? a.right - width : placement === 'above-center' ? a.left + a.width / 2 - width / 2 : a.left
    const top = placement === 'below-end' ? a.bottom + margin : a.top - h - margin
    setPos({ top: Math.max(margin, top), left: Math.min(window.innerWidth - width - margin, Math.max(margin, left)) })
  }, [open, anchor, placement, width])

  // Callers pass inline arrows; keep the latest in a ref so the effect below
  // runs only when the popover opens or closes (focus moves in once, back once).
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    if (!open) return
    const node = ref.current
    const anchorEl = anchor.current
    focusables(node ?? document.body)[0]?.focus()
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (node && !node.contains(t) && !anchorEl?.contains(t)) close.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      anchorEl?.focus()
    }
  }, [open, anchor])
  useEscapeLayer(open, onClose)

  if (!mounted) return null
  return createPortal(
    <div
      ref={ref}
      className="popover"
      role="dialog"
      aria-labelledby={labelledBy}
      inert={leaving}
      data-leaving={leaving || undefined}
      style={{ width, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** Keeps Tab inside `root` and closes on Escape (unless `locked`). Returns focus on unmount. */
export function useFocusTrap(root: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void, locked = false) {
  useEffect(() => {
    if (!active) return
    const previous = document.activeElement as HTMLElement | null
    const node = root.current
    if (node) (focusables(node)[0] ?? node).focus()
    const onKey = (e: KeyboardEvent) => {
      if (!node || e.key !== 'Tab') return
      const list = focusables(node)
      const first = list[0]
      const last = list[list.length - 1]
      if (!first || !last) return
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus()
    }
  }, [active, root])
  // While locked (e.g. mid-encode) the layer still swallows Escape so nothing beneath reacts.
  useEscapeLayer(active, () => {
    if (!locked) onEscape()
  })
}

/** How long a toast stays when nobody is looking at it. */
const TOAST_MS = 4000

interface ToastItemProps {
  toast: Toast
  dismiss: (id: number) => void
  /** Dismissed and playing its exit (150 ms): inert, its timer stopped. */
  leaving: boolean
  onExited: (id: number) => void
}

/** One toast with its own timer, held while hovered or focused. */
function ToastItem({ toast, dismiss, leaving, onExited }: ToastItemProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [held, setHeld] = useState(false)
  const { id } = toast
  useEffect(() => {
    if (held || leaving) return
    const timer = window.setTimeout(() => dismiss(id), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [held, leaving, id, dismiss])
  useExit(leaving, [{ ref, kind: 'toast' }], () => onExited(id))
  return (
    <div
      ref={ref}
      className="toast"
      data-tone={toast.tone}
      inert={leaving}
      data-leaving={leaving || undefined}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      {toast.tone === 'stop' ? <WarningCircle className="icon" aria-hidden="true" /> : null}
      <span>{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action?.run()
            dismiss(id)
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" className="btn-icon sm" aria-label="Dismiss" onClick={() => dismiss(id)}>
        <X className="icon" aria-hidden="true" />
      </button>
    </div>
  )
}

const toastKey = (t: Toast): number => t.id

/** A toast the store merged into an identical newer one goes without an exit, so a burst never blinks. */
function mergedInto(gone: Toast, now: readonly Toast[]): boolean {
  return !gone.action && now.some((t) => !t.action && t.message === gone.message && t.tone === gone.tone)
}

/**
 * Bottom-centre toasts; each disappears 4 s after it appears, held while
 * hovered or focused. A dismissed toast slides down and fades (150 ms) in its
 * place before the others close up.
 */
export function Toasts() {
  const toasts = useView((s) => s.toasts)
  const dismiss = useView((s) => s.dismissToast)
  const { entries, done } = usePresenceList(toasts, toastKey, mergedInto)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {entries.map(({ item, leaving }) => (
        <ToastItem key={item.id} toast={item} dismiss={dismiss} leaving={leaving} onExited={done} />
      ))}
    </div>
  )
}

interface NoticeProps {
  tone: 'stop' | 'safelight'
  title?: string
  children: ReactNode
  action?: ReactNode
}

/** An inline notice at the point of the problem (never a banner). */
export function Notice({ tone, title, children, action }: NoticeProps) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'stop' ? 'alert' : 'status'}>
      <Warning className="icon" aria-hidden="true" />
      <div>
        {title ? <strong>{title}</strong> : null}
        <p>{children}</p>
      </div>
      {action ?? <span />}
    </div>
  )
}
