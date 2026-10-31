// Pure Reference-screen rules: when a scan may start, and when levelling the eyes applies.
import type { ReferenceImage, SessionSnapshot } from '../../ipc/contract'
import { eyesLevel } from '../shell/ledger'
import { countOf, formatCount } from '../../lib/format'

/** Why the scan can't start yet, or null when it can (`models`: why the face models can't be used, if so). */
export function scanBlocker(session: SessionSnapshot, busy: boolean, models: string | null = null): string | null {
  if (busy) return 'Another task is running. Wait for it to finish or cancel it.'
  if (models) return models
  if (!session.reference) return 'Choose a reference photo first.'
  if (!session.reference.detection) return 'No face inside the crop yet.'
  if (!session.folder) return 'Choose a source folder first.'
  return null
}

/**
 * The rotation that levels the eyes, or null when there is nothing to level:
 * no face, or the eyes already read as level. `autoRotationDeg` is absolute,
 * so one press converges. The tolerance (`eyesLevel`) is wider than the
 * contract's 0.3°, so tilts the readout calls level are never applied: the
 * backend keeps the crop through a rotation, but a rotation still re-renders
 * the reference and stales every aligned frame, so callers rotate only for a
 * non-null result (the `L` key and the inspector button share this).
 */
export function levelRotation(image: Pick<ReferenceImage, 'rotationDeg' | 'autoRotationDeg'>): number | null {
  const auto = image.autoRotationDeg
  return auto === null || eyesLevel(image.rotationDeg, auto) ? null : auto
}

/** What Reference's plate does: scan (the first, a resume or the new photos), or go on to Review or Days. */
export interface SetupPlate {
  action: 'scan' | 'review' | 'days'
  label: string
}

/**
 * The plate is the next step (critique round 4, P2-11): before the first scan,
 * scan the library (or resume a stopped scan); after it, scan only the new
 * photos waiting, else review what is unsure, else open Days. Scanning again
 * from scratch is a quiet row in the inspector.
 */
export function setupPlate(session: SessionSnapshot): SetupPlate {
  const { folder, scan } = session
  if (scan.status !== 'complete' || !folder) return { action: 'scan', label: scan.status === 'partial' ? 'Resume scan' : 'Scan library' }
  const waiting = Math.max(0, folder.imageCount - folder.analyzedCount)
  if (waiting > 0) return { action: 'scan', label: `Scan ${countOf(waiting, 'new photo')}` }
  if (session.counts.reviewPending > 0) return { action: 'review', label: `Review ${formatCount(session.counts.reviewPending)} unsure` }
  return { action: 'days', label: 'Open Days' }
}

