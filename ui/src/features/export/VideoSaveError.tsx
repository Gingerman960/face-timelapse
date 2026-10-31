import { WarningCircle } from '@phosphor-icons/react'
import { useVideoDraft } from '../../state/videoDraft'

/**
 * Why the backend refused the video settings being edited (contract v1.5
 * `set_video_settings`, the export's own validation). The draft stays on
 * screen so the user can correct it; this says why it isn't saved.
 */
export function VideoSaveError({ className }: { className?: string }) {
  const error = useVideoDraft((s) => s.error)
  if (!error) return null
  return (
    <p className={['video-save-error', className].filter(Boolean).join(' ')} role="alert">
      <WarningCircle className="icon" aria-hidden="true" />
      <span>Not saved. {error.message}</span>
    </p>
  )
}
