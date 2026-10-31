import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react'
import { reloadWindow } from '../../lib/reload'
import { PlateButton, QuietButton } from './Button'

interface ErrorBoundaryProps {
  /** What to show instead of the children after a render-time throw; `retry` renders them again. */
  fallback: (error: Error, retry: () => void) => ReactNode
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/** The messages Chromium, WebKit and Gecko give when a lazy chunk can't be fetched. */
const CHUNK_LOAD_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i

/**
 * True when a screen's own code failed to load. Try again can't help then: the
 * failed import stays failed until the window reloads (UI review 3, L4).
 */
export function isChunkLoadError(error: Error): boolean {
  return CHUNK_LOAD_ERROR.test(error.message)
}

function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown))
}

/**
 * Catches a render-time throw below it (a malformed date from the backend, a
 * lazy chunk that failed to load) so it costs one screen, not the window
 * (UI review 2, M7). Mount it with a `key` to start over with new content.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(thrown: unknown): ErrorBoundaryState {
    return { error: toError(thrown) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The one place a crash is recorded: the webview console, with where it happened.
    console.error('[FaceTimelapse] a screen stopped working', error, info.componentStack)
  }

  private readonly retry = (): void => this.setState({ error: null })

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error, this.retry) : this.props.children
  }
}

interface CrashPanelProps {
  /** The screen (or "FaceTimelapse" for the whole window). */
  title: string
  error: Error
  /** Renders the screen again; absent when only a reload can help. */
  onRetry?: () => void
}

/**
 * The calm fallback: what stopped, that nothing is lost (every choice is saved
 * as it is made), and two ways on, Try again and Reload. The error itself is
 * small print, for a bug report.
 */
export function CrashPanel({ title, error, onRetry }: CrashPanelProps) {
  return (
    <div className="crash" role="alert">
      <WarningCircle className="icon crash-icon" aria-hidden="true" />
      <h2>{title} stopped working</h2>
      <p>Nothing you made is lost: your choices are saved as you make them. Try again, or reload the window.</p>
      <div className="row">
        {onRetry ? <PlateButton onClick={onRetry}>Try again</PlateButton> : null}
        <QuietButton icon={<ArrowClockwise className="icon" aria-hidden="true" />} onClick={reloadWindow}>
          Reload the window
        </QuietButton>
      </div>
      <p className="crash-detail mono-meta">
        {error.name}: {error.message}
      </p>
    </div>
  )
}
