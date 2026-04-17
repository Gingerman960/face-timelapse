import React from 'react'
import useAlignmentStore from './store/alignmentStore'
import SetupView from './views/SetupView'
import ScanningView from './views/ScanningView'
import ConfirmView from './views/ConfirmView'
import DailySelectionView from './views/DailySelectionView'
import AligningView from './views/AligningView'
import ResultsView from './views/ResultsView'

const STEP_LABELS = {
  setup: '1. Setup',
  scanning: '2. Scan',
  confirm: '3. Confirm',
  dailySelection: '4. Select',
  aligning: '5. Align',
  results: '6. Results'
}

const STEP_ORDER = ['setup', 'scanning', 'confirm', 'dailySelection', 'aligning', 'results']

// Steps that are transient (in-progress) and should not be navigated to directly
const NON_NAVIGABLE = new Set(['scanning', 'aligning'])

export default function App() {
  const { step, error, clearError, setStep } = useAlignmentStore()

  const currentStepIdx = STEP_ORDER.indexOf(step)

  const handleStepClick = (targetStep, targetIdx) => {
    if (targetIdx >= currentStepIdx) return
    if (NON_NAVIGABLE.has(targetStep)) return
    setStep(targetStep)
  }

  const renderView = () => {
    switch (step) {
      case 'setup': return <SetupView />
      case 'scanning': return <ScanningView />
      case 'confirm': return <ConfirmView />
      case 'dailySelection': return <DailySelectionView />
      case 'aligning': return <AligningView />
      case 'results': return <ResultsView />
      default: return <SetupView />
    }
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <span className="app-title">FaceTimelapse</span>
        <nav className="app-steps" aria-label="Workflow steps">
          {STEP_ORDER.map((s, i) => {
            const isCompleted = i < currentStepIdx
            const isClickable = isCompleted && !NON_NAVIGABLE.has(s)
            let stepClass = 'step-badge'
            if (i <= currentStepIdx) stepClass += ' active'
            if (i === currentStepIdx) stepClass += ' current'
            if (isClickable) stepClass += ' clickable'

            const label = STEP_LABELS[s]

            // Rendered as a button only when clickable, so non-interactive
            // steps don't announce themselves as buttons to screen readers.
            if (isClickable) {
              return (
                <button
                  type="button"
                  key={s}
                  className={stepClass}
                  onClick={() => handleStepClick(s, i)}
                  title={`Go back to ${label}`}
                  aria-label={`Go back to ${label}`}
                  aria-current={i === currentStepIdx ? 'step' : undefined}
                >
                  {label}
                </button>
              )
            }

            return (
              <span
                key={s}
                className={stepClass}
                aria-current={i === currentStepIdx ? 'step' : undefined}
              >
                {label}
              </span>
            )
          })}
        </nav>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={clearError} aria-label="Dismiss error">×</button>
        </div>
      )}

      <main className="app-main">
        {renderView()}
      </main>
    </div>
  )
}
