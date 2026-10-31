import { Check, Warning } from '@phosphor-icons/react'
import type { IpcError, ReferenceState, Size } from '../../ipc/contract'
import { Notice } from '../../components/ui/Overlays'
import { TickMark } from '../../components/ui/Mark'
import { DataText } from '../../components/ui/DataText'
import { eyesLevel, residualTilt } from '../shell/ledger'

interface ReferenceReadoutsProps {
  reference: ReferenceState
  error: IpcError | null
  /** True while a crop edit is uncommitted or in flight. */
  finding: boolean
  /** Output frame size for the current crop, if known. */
  output: Size | null
  busy: boolean
  /** The reference has just arrived: "Face found" is ticked by the pen. */
  arrival?: boolean
  onChooseAnother: () => void
}

function Finding() {
  return (
    <div className="readouts" role="status">
      <span>
        <i className="indeterminate" aria-hidden="true" />
        Finding your face…
      </span>
    </div>
  )
}

function NoFace({ busy, onChooseAnother }: Pick<ReferenceReadoutsProps, 'busy' | 'onChooseAnother'>) {
  return (
    <div className="readouts" role="status">
      <span className="warn">
        <Warning className="icon" aria-hidden="true" />
        No face found inside the crop. Widen the crop or pick another reference photo.
      </span>
      <button type="button" className="btn-text" onClick={onChooseAnother} disabled={busy}>
        Choose another photo…
      </button>
    </div>
  )
}

function FaceFound({ reference, output, arrival }: Pick<ReferenceReadoutsProps, 'reference' | 'output' | 'arrival'>) {
  const { rotationDeg, autoRotationDeg } = reference.image
  const level = eyesLevel(rotationDeg, autoRotationDeg)
  // The tilt that remains (QA 4); the rotation already applied is in the caption above the print.
  const tilt = residualTilt(rotationDeg, autoRotationDeg)
  return (
    <div className="readouts">
      <span>
        {level ? <Check className="icon ok" aria-hidden="true" /> : <Warning className="icon" aria-hidden="true" />}
        {level ? 'Eyes level' : 'Tilted'} <b className="mono">{tilt === null ? '' : `${Math.abs(tilt).toFixed(1)}°`}</b>
      </span>
      <span>
        <TickMark neutral draw={arrival} className="readout-tick" />
        <DataText>Face found · 5 points</DataText>
      </span>
      {output ? (
        <span>
          Output <b className="mono">{output.width} × {output.height}</b>
        </span>
      ) : null}
      <span className="hint">Drag the frame to move it, the corners to resize. Arrow keys nudge.</span>
    </div>
  )
}

/** The line under the print: an error, "Finding your face…", the face readouts, or the no-face state. */
export function ReferenceReadouts({ reference, error, finding, output, busy, arrival, onChooseAnother }: ReferenceReadoutsProps) {
  if (error) {
    return (
      <Notice tone="stop" title="That didn't work.">
        {error.message}
      </Notice>
    )
  }
  if (finding) return <Finding />
  if (reference.detection) return <FaceFound reference={reference} output={output} arrival={arrival} />
  return <NoFace busy={busy} onChooseAnother={onChooseAnother} />
}
