import { X } from '@phosphor-icons/react'
import type { AlignFailure } from '../../ipc/contract'
import { formatCount } from '../../lib/format'
import { IconButton } from '../../components/ui/Button'

/** Entries listed; the rest are in Days. */
const SHOWN = 4

interface AlignFailuresProps {
  failures: readonly AlignFailure[]
  onDismiss: () => void
  /** Opens Days, where the failed days can be fixed. */
  onOpen: () => void
}

/** After an align: a dismissible list of frames that couldn't be aligned, each linking to Days. */
export function AlignFailures({ failures, onDismiss, onOpen }: AlignFailuresProps) {
  if (failures.length === 0) return null
  return (
    <div className="align-failures" role="status">
      <span className="row">
        {formatCount(failures.length)} {failures.length === 1 ? 'day' : 'days'} couldn’t be aligned.
        <IconButton small label="Dismiss" onClick={onDismiss}>
          <X className="icon" aria-hidden="true" />
        </IconButton>
      </span>
      {failures.slice(0, SHOWN).map((f) => (
        <button key={f.photoId} type="button" className="btn-text" onClick={onOpen}>
          {f.error.message}
        </button>
      ))}
    </div>
  )
}
