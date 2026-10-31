import { useId, useState } from 'react'
import { WarningCircle } from '@phosphor-icons/react'
import { useSession } from '../../state/queries'
import { MODELS_MISSING, useModelsInfo } from '../../state/models'

/**
 * What still works without the models, promising only what this session has:
 * a session opened with the models before restores read-only with its photos,
 * days and frames (QA N5); one that never had them restores nothing.
 */
export function stillWorks(frames: number, photos: number): string | null {
  if (frames > 0) return 'Watching and exporting the frames you have still work.'
  if (photos > 0) return 'Reviewing photos and choosing days still work.'
  return null
}

/**
 * The face models can't be used (QA; v1.6 `modelsError`, or a command that
 * answered `modelUnavailable`): a calm, persistent note in the ledger above
 * the footer, on every screen (critique round 3: a neutral surface, one
 * semantic accent, concise copy, the backend's reason on demand). Scanning,
 * aligning, adding a photo and nudging a frame are off, their tooltips say
 * why. In the collapsed rail only the icon shows, with the sentence as its
 * tooltip.
 */
export function ModelsNotice() {
  const { status, error } = useModelsInfo()
  const session = useSession().data
  const works = stillWorks(session?.frames.count ?? 0, session?.counts.total ?? 0)
  const [open, setOpen] = useState(false)
  const detailId = useId()
  if (status !== 'missing') return null
  return (
    <section className="models-notice" role="status" aria-labelledby="models-notice-title" title={MODELS_MISSING}>
      <WarningCircle className="icon" aria-hidden="true" />
      <div className="models-notice-text">
        <h2 id="models-notice-title">Face models are missing</h2>
        {works ? (
          <>
            <p>Reinstall FaceTimelapse to scan or align.</p>
            <p>{works}</p>
          </>
        ) : (
          <p>Faces can’t be found until FaceTimelapse is reinstalled.</p>
        )}
        {error ? (
          <>
            <button type="button" className="btn-text models-detail-toggle" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>
              {open ? 'Hide details' : 'Details'}
            </button>
            {open ? (
              <p className="models-detail" id={detailId}>
                {error}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  )
}
