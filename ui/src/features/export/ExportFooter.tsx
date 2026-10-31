import { ArrowSquareOut, Play, Stop } from '@phosphor-icons/react'
import { PlateButton, QuietButton } from '../../components/ui/Button'
import { revealPath } from '../../state/actions'
import { cancelActiveJob } from '../../state/jobs'
import type { SheetPhase } from './ExportBodies'
import type { ExportFormat } from './exportModel'

interface ExportFooterProps {
  phase: SheetPhase
  format: ExportFormat
  canExport: boolean
  onExport: () => void
  onClose: () => void
  /** Opens the saved video in its default player, then closes the sheet. */
  onPlay: () => void
  /** What Show in Finder reveals once saved. */
  savedPath: string
}

/**
 * Settings: Cancel and Export (the spec line moved under the preview, as
 * facts). Encoding: Stop. Saved video: Show in Finder, Done and Play ⌘↩ as
 * the plate, which opens the saved file in the default player (contract v1.7
 * `open_path`); the spread above is "Watch here". Saved frames: Show in Finder
 * and Done ⌘↩.
 */
export function ExportFooter({ phase, format, canExport, onExport, onClose, onPlay, savedPath }: ExportFooterProps) {
  if (phase === 'encoding') {
    return (
      <footer className="sheet-foot">
        <div className="row end">
          <QuietButton icon={<Stop className="icon" aria-hidden="true" />} kbd="⌘." onClick={() => void cancelActiveJob()}>
            Stop
          </QuietButton>
        </div>
      </footer>
    )
  }
  if (phase === 'done') {
    return (
      <footer className="sheet-foot">
        <QuietButton icon={<ArrowSquareOut className="icon" aria-hidden="true" />} onClick={() => void revealPath(savedPath)}>
          Show in Finder
        </QuietButton>
        <div className="row end">
          {format === 'video' ? (
            <>
              <QuietButton onClick={onClose}>Done</QuietButton>
              <PlateButton kbd="⌘↩" icon={<Play className="icon" weight="fill" aria-hidden="true" />} title="Open the video in your default player" onClick={onPlay}>
                Play
              </PlateButton>
            </>
          ) : (
            <PlateButton kbd="⌘↩" onClick={onClose}>
              Done
            </PlateButton>
          )}
        </div>
      </footer>
    )
  }
  return (
    <footer className="sheet-foot">
      <div className="row end">
        <QuietButton onClick={onClose}>Cancel</QuietButton>
        <PlateButton kbd="⌘↩" onClick={onExport} disabled={!canExport} title={canExport ? undefined : 'Check the highlighted settings.'}>
          Export…
        </PlateButton>
      </div>
    </footer>
  )
}
