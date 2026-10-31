import { useRef, type ReactNode } from 'react'
import { useClaimScreenFocus } from './useScreenFocus'
import { useTransitionHold } from './stepTransition'

interface ScreenProps {
  title: string
  subtitle?: ReactNode
  center?: ReactNode
  tools?: ReactNode
  ribbon?: ReactNode
  children: ReactNode
  className?: string
  /** True while the screen's code or data is still loading. */
  busy?: boolean
}

/**
 * One screen inside the main column: the integrated toolbar (a window drag
 * region; its controls stay clickable), the canvas, and an optional ribbon.
 */
export function Screen({ title, subtitle, center, tools, ribbon, children, className, busy = false }: ScreenProps) {
  const region = useRef<HTMLElement>(null)
  useClaimScreenFocus(region, busy)
  // A screen still loading (its code, or its data: no content yet) holds a running transition's capture.
  useTransitionHold(busy || children === null || children === undefined)
  return (
    <>
      <header className="toolbar" data-tauri-drag-region data-screen={title}>
        <div className="tb-title" data-tauri-drag-region>
          <h1 data-tauri-drag-region>{title}</h1>
          {subtitle ? (
            <span className="tb-sub" data-tauri-drag-region>
              {subtitle}
            </span>
          ) : null}
        </div>
        <div className="tb-center" data-tauri-drag-region>
          {center}
        </div>
        <div className="tb-tools">{tools}</div>
      </header>
      {/* Focusable from script only: focus lands here after a step change (useScreenFocus). */}
      <section className={['screen', className].filter(Boolean).join(' ')} aria-label={title} aria-busy={busy || undefined} tabIndex={-1} ref={region} data-screen={title}>
        {children}
      </section>
      {ribbon ?? null}
    </>
  )
}
