import type { ReactNode } from 'react'
import type { FolderInfo } from '../../ipc/contract'
import { Facts } from '../../components/ui/Controls'
import { EdgePrint } from '../../components/ui/EdgePrint'
import { formatCount } from '../../lib/format'
import { Screen } from '../shell/Screen'

/** Why there is nothing to show: the folder has no photos, or the face models are missing (null: just not scanned). */
export type ScanEmptyReason = 'noPhotos' | 'models' | null

const WHY: Record<NonNullable<ScanEmptyReason> | 'none', string> = {
  // UI review 4, L4: a rescan of a folder with no photos can only find nothing.
  noPhotos: 'This folder has no photos FaceTimelapse can read. Choose the folder with your daily photos.',
  models: 'The face models are missing, so this library can’t be read. Reinstall FaceTimelapse, then scan again.',
  none: 'Scan the library to find your face in it.',
}

/** Unexposed film under the statement: two strips, as long as the sheet's strips (10, or 7 when compact). */
const FILM_STRIPS = 2
const FILM_FRAMES = 10

interface ScanEmptyProps {
  reason: ScanEmptyReason
  /** The library folder, for the facts beside the statement. */
  folder?: FolderInfo | null
  subtitle: ReactNode
  tools: ReactNode
}

/** What the folder holds, as far as the app knows without a scan. */
function folderFacts(folder: FolderInfo) {
  return [
    { label: 'Folder', value: folder.name },
    { label: 'Photos', value: folder.imageCount > 0 ? formatCount(folder.imageCount) : 'None it can read', mono: folder.imageCount > 0 },
    ...(folder.unsupportedCount > 0 ? [{ label: 'Other formats', value: formatCount(folder.unsupportedCount) }] : []),
    ...(folder.analyzedCount > 0 ? [{ label: 'Read before', value: formatCount(folder.analyzedCount) }] : []),
  ]
}

/** Two strips of film with nothing on them yet: only the edge numbers the maker printed. */
function UnexposedFilm() {
  return (
    <div className="scan-empty-film" aria-hidden="true">
      {Array.from({ length: FILM_STRIPS }, (_, strip) => (
        <div key={strip} className="strip is-static">
          {Array.from({ length: FILM_FRAMES }, (_, frame) => (
            <div key={frame} className="frame-cell unexposed">
              <EdgePrint n={strip * FILM_FRAMES + frame + 1} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * The Scan screen with no scan results to show (N5). A finished scan with no
 * photos used to read "Found you in 0 of 0 photos · Read in 40 s"; with the
 * face models missing that claimed a scan the app can't run. It says what is
 * true instead, and keeps the band's shape (critique round 4, P2-20): the
 * statement and why, the folder's facts where the rate would be, and two
 * strips of unexposed film where the contact sheet would be. No ribbon.
 */
export function ScanEmpty({ reason, folder, subtitle, tools }: ScanEmptyProps) {
  return (
    <Screen title="Scan" subtitle={subtitle} tools={tools}>
      <div className="scan-screen scan-empty">
        <div className="scan-band">
          <div className="scan-line">
            <h2>No scan results to show</h2>
            <p className="scan-empty-why">{WHY[reason ?? 'none']}</p>
          </div>
          {folder ? <Facts className="scan-empty-facts" rows={folderFacts(folder)} /> : null}
        </div>
        <UnexposedFilm />
      </div>
    </Screen>
  )
}
