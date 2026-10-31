import { lazy, Suspense, useEffect } from 'react'
import { DropOverlay } from './features/shell/DropOverlay'
import { Screen } from './features/shell/Screen'
import { Sidebar } from './features/shell/Sidebar'
import { useApplyTheme, useMaxWidth } from './features/shell/useTheme'
import { useAdoptOrphanJob, useAppKeys, useSessionChangedEvents, useShowKeysEvents, useShowWindowWhenReady, useStepRouter } from './features/shell/useAppRuntime'
import { CrashPanel, ErrorBoundary, isChunkLoadError } from './components/ui/ErrorBoundary'
import { Toasts, Notice } from './components/ui/Overlays'
import { QuietButton } from './components/ui/Button'
import { useJobs } from './state/jobs'
import { useModelsWatch } from './state/models'
import { useSession } from './state/queries'
import { useView } from './state/view'
import type { Step } from './lib/steps'
import { DaysScreen, ReviewScreen, ScanScreen, SetupScreen, TimelapseScreen, preloadScreensWhenIdle } from './features/shell/screens'
import { useShownStep } from './features/shell/stepTransition'
import { useScreenFocus } from './features/shell/useScreenFocus'
import { KeyMap } from './features/shell/KeyMap'

const ExportSheet = lazy(() => import('./features/export/ExportSheet'))

const TITLES: Record<Step, string> = {
  setup: 'Reference',
  scan: 'Scan',
  review: 'Review',
  days: 'Days',
  align: 'Timelapse',
  timelapse: 'Timelapse',
}

function CurrentScreen({ step }: { step: Step }) {
  switch (step) {
    case 'setup':
      return <SetupScreen />
    case 'scan':
      return <ScanScreen />
    case 'review':
      return <ReviewScreen />
    case 'days':
      return <DaysScreen />
    case 'align':
    case 'timelapse':
      return <TimelapseScreen />
  }
}

/** Every screen's code is fetched while the app is idle (the screen changes themselves travel in useShownStep). */
function useContinuity(): void {
  useEffect(() => preloadScreensWhenIdle(), [])
}

function StartupError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Screen title="FaceTimelapse">
      <div className="empty-hint">
        <Notice tone="stop" title="FaceTimelapse couldn't start." action={<QuietButton onClick={retry}>Try again</QuietButton>}>
          {message}
        </Notice>
      </div>
    </Screen>
  )
}

/**
 * The export sheet crashed: say so in a toast and close it, leaving the
 * timelapse as it was. While an export runs, E can't open the sheet, but the
 * export goes on and the sidebar shows it (UI review 3, L4).
 */
function SheetCrash({ error }: { error: Error }) {
  useEffect(() => {
    const exporting = useJobs.getState().activeKind === 'exportVideo' || useJobs.getState().activeKind === 'exportImages'
    const next = exporting ? 'The export goes on; its progress shows in the sidebar.' : 'Open it again with E.'
    useView.getState().pushToast({ message: `The export sheet stopped working (${error.message}). ${next}`, tone: 'stop' })
    useView.getState().setExportOpen(false)
  }, [error])
  return null
}

/** The window: floating ledger sidebar, the current screen, sheets and overlays. */
export function App() {
  useApplyTheme()
  useAppKeys()
  useStepRouter()
  useAdoptOrphanJob()
  useSessionChangedEvents()
  useShowKeysEvents()
  const session = useSession()
  useModelsWatch()
  useShowWindowWhenReady(session.isSuccess || session.isError)
  useContinuity()
  // The screen on show follows the target step inside a View Transition (UI review 5, H1).
  const step = useShownStep()
  const announcement = useScreenFocus(TITLES[step])
  const exportOpen = useView((s) => s.exportOpen)
  const narrow = useMaxWidth(1180)
  const collapsed = useView((s) => s.sidebarCollapsed) || narrow
  return (
    <div className="window" data-sidebar={collapsed ? 'collapsed' : 'expanded'} data-step={step}>
      <Sidebar />
      <main className="main" id="main">
        {session.data === undefined && session.isError ? (
          <StartupError message={session.error instanceof Object && 'message' in session.error ? String(session.error.message) : 'Unknown error.'} retry={() => void session.refetch()} />
        ) : session.data !== undefined ? (
          <Suspense fallback={<Screen title={TITLES[step]} busy>{null}</Screen>}>
            {/* One boundary per screen (UI review 2, M7): a crash costs that screen, not the window.
                Keyed by the screen, not the step: aligning and the player are one screen that keeps its state. */}
            <ErrorBoundary
              key={TITLES[step]}
              fallback={(error, retry) => (
                <Screen title={TITLES[step]}>
                  <CrashPanel title={TITLES[step]} error={error} onRetry={isChunkLoadError(error) ? undefined : retry} />
                </Screen>
              )}
            >
              <CurrentScreen step={step} />
            </ErrorBoundary>
          </Suspense>
        ) : (
          <Screen title={TITLES[step]} busy>
            {null}
          </Screen>
        )}
      </main>
      {exportOpen ? (
        <Suspense fallback={null}>
          <ErrorBoundary fallback={(error) => <SheetCrash error={error} />}>
            <ExportSheet />
          </ErrorBoundary>
        </Suspense>
      ) : null}
      <DropOverlay />
      <Toasts />
      <KeyMap />
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
