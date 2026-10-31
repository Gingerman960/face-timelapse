import { useRef, useState } from 'react'
import { DotsThree } from '@phosphor-icons/react'
import { IconButton, QuietButton, StopButton } from '../../components/ui/Button'
import { Popover } from '../../components/ui/Overlays'
import { reportError, resetSession } from '../../state/actions'
import { useJobs } from '../../state/jobs'
import { useView } from '../../state/view'

/**
 * "Start a new timelapse…": the deliberate way back to the empty Reference
 * screen (reset_session). Asks first; caches and exported files stay, so the
 * same folder scans quickly and recents are offered.
 */
export function StartOverButton() {
  const busy = useJobs((s) => s.activeJobId !== null)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const startOver = () => {
    setOpen(false)
    void resetSession()
      .then(() => useView.getState().setStep('setup'))
      .catch(reportError)
  }
  return (
    <>
      <IconButton ref={anchor} small className="project-more" label="Project options" aria-expanded={open} onClick={() => setOpen(true)} disabled={busy}>
        <DotsThree className="icon" weight="bold" aria-hidden="true" />
      </IconButton>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} labelledBy="start-over-title" placement="below-end" width={300}>
        <h3 id="start-over-title">Start a new timelapse?</h3>
        <p>
          The reference, the folder, your review calls and day picks are cleared. Photos already read stay remembered, and exported files
          aren’t touched.
        </p>
        <div className="row end">
          <QuietButton onClick={() => setOpen(false)}>Cancel</QuietButton>
          <StopButton onClick={startOver}>Start over</StopButton>
        </div>
      </Popover>
    </>
  )
}
