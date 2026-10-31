import type { ReactNode } from 'react'
import { FolderOpen, FolderSimple, Image as ImageIcon } from '@phosphor-icons/react'
import type { FolderInfo, Recents } from '../../ipc/contract'
import { PlateButton, QuietButton } from '../../components/ui/Button'
import { usePathDisplay } from '../../hooks/usePathDisplay'

interface SetupEmptyProps {
  folder: FolderInfo | null
  recents: Recents
  disabled: boolean
  onChoosePhoto: () => void
  onChooseFolder: () => void
  onRecentPhoto: (path: string) => void
  onRecentFolder: (path: string) => void
  /** "this Mac" / "this PC" / "this computer". */
  machine?: string
  /** Why the last photo pick failed, shown under the photo actions. */
  photoNotice?: ReactNode
  /** Why the last folder pick failed, shown under the folder actions. */
  folderNotice?: ReactNode
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** First run: one large reference drop frame, then the folder; recents after a reset. */
export function SetupEmpty({ folder, recents, disabled, onChoosePhoto, onChooseFolder, onRecentPhoto, onRecentFolder, machine = 'this Mac', photoNotice, folderNotice }: SetupEmptyProps) {
  const showPath = usePathDisplay()
  return (
    <div className="setup-empty">
      <div className="drop-ref">
        <div className="drop-frame" aria-hidden="true">
          <svg className="template" viewBox="0 0 400 500" preserveAspectRatio="xMidYMid meet">
            <ellipse cx="200" cy="246" rx="96" ry="128" />
            <line x1="40" y1="220" x2="360" y2="220" />
            <line x1="200" y1="70" x2="200" y2="430" />
            <line className="t-chin" x1="120" y1="374" x2="280" y2="374" />
            <circle className="t-eye" cx="150" cy="220" r="4.5" />
            <circle className="t-eye" cx="250" cy="220" r="4.5" />
          </svg>
          <span className="label-caps">Drop a photo here</span>
        </div>
        <div className="drop-copy">
          <h2>Start with one photo of your face</h2>
          <p>Each day’s photo is lined up to this one. Front-on, eyes open, even light works best.</p>
          <div className="row">
            <PlateButton kbd="⌘O" onClick={onChoosePhoto} disabled={disabled}>
              Choose photo…
            </PlateButton>
          </div>
          {photoNotice}
          {recents.references.length > 0 ? (
            <div className="recent">
              <p className="label-caps">Recent</p>
              {recents.references.slice(0, 3).map((p) => (
                <button key={p} type="button" onClick={() => onRecentPhoto(p)} disabled={disabled}>
                  <ImageIcon className="icon" aria-hidden="true" />
                  <span>
                    <strong>{baseName(p)}</strong>
                    <span className="mono-meta path" title={p}>
                      {showPath(p)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="drop-lib">
        <FolderOpen className="icon" aria-hidden="true" />
        <h3>{folder ? folder.name : 'Then the folder of daily photos'}</h3>
        <p>
          {folder
            ? `${folder.imageCount.toLocaleString('en-US')} photos found, subfolders included.`
            : `Subfolders are included. Photos are read, never moved or changed, and nothing leaves ${machine}.`}
        </p>
        <QuietButton icon={<FolderSimple className="icon" aria-hidden="true" />} kbd="⇧⌘O" onClick={onChooseFolder} disabled={disabled}>
          {folder ? 'Choose another folder…' : 'Choose folder…'}
        </QuietButton>
        {folderNotice}
        {recents.folders.length > 0 ? (
          <div className="recent">
            <p className="label-caps">Recent</p>
            {recents.folders.slice(0, 3).map((p) => (
              <button key={p} type="button" onClick={() => onRecentFolder(p)} disabled={disabled}>
                <FolderSimple className="icon" aria-hidden="true" />
                <span>
                  <strong>{baseName(p)}</strong>
                  <span className="mono-meta path" title={p}>
                    {showPath(p)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
