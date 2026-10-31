import { useEffect, useState } from 'react'
import { FolderSimple, UserFocus } from '@phosphor-icons/react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { reportError, setReferencePhoto, setSourceFolder } from '../../state/actions'
import { useJobs } from '../../state/jobs'
import { useView } from '../../state/view'

/** Photo extensions the reference picker accepts; the backend still validates the file. */
const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|tiff?|bmp|gif)$/i
const BUSY_MESSAGE = 'Another task is running. Wait for it to finish or cancel it.'
const EMPTY_DROP_MESSAGE = 'Drop one photo of your face, or the folder of daily photos.'

export interface DropTargets {
  image: string | null
  folder: string | null
}

/**
 * Splits dropped paths (ARCHITECTURE §8): the first image, by extension, is
 * the reference; the first other path is the library folder. Only the
 * backend knows what is a folder (names like "Selfies 2014.08" are fine), so
 * anything else is left to it to refuse with `invalidArgument`.
 */
export function classifyDrop(paths: readonly string[]): DropTargets {
  const image = paths.find((p) => IMAGE_EXT.test(p)) ?? null
  const folder = paths.find((p) => !IMAGE_EXT.test(p)) ?? null
  return { image, folder }
}

/** True while a modal sheet owns the window; drops are ignored then (no overlay, no command). */
function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}

/** Runs one drop command; a refusal (e.g. "That's a file, not a folder") shows the backend's message. */
async function attempt(command: () => Promise<unknown>): Promise<void> {
  try {
    await command()
  } catch (error) {
    reportError(error)
  }
}

/** Applies a drop: image → reference, other path → library. Busy- and modal-aware; each refusal is a toast. */
export async function applyDrop(paths: readonly string[]): Promise<void> {
  if (modalOpen()) return
  const view = useView.getState()
  if (useJobs.getState().activeJobId) {
    view.pushToast({ message: BUSY_MESSAGE, tone: 'stop' })
    return
  }
  const { image, folder } = classifyDrop(paths)
  if (!image && !folder) {
    view.pushToast({ message: EMPTY_DROP_MESSAGE, tone: 'stop' })
    return
  }
  view.setStep('setup')
  if (image) await attempt(() => setReferencePhoto(image))
  if (folder) await attempt(() => setSourceFolder(folder))
}

/** Full-window target while the OS drags files over the app. */
export function DropOverlay() {
  const [paths, setPaths] = useState<string[] | null>(null)
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload
          if (p.type === 'enter') setPaths(modalOpen() ? null : p.paths)
          else if (p.type === 'drop') {
            setPaths(null)
            void applyDrop(p.paths)
          } else if (p.type === 'leave') setPaths(null)
        })
        .then((fn) => {
          if (disposed) fn()
          else unlisten = fn
        })
        .catch(() => undefined)
    } catch {
      /* not running inside Tauri and no mock installed: no OS drops */
    }
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
  if (!paths) return null
  const { image, folder } = classifyDrop(paths)
  return (
    <div className="drop-overlay" role="dialog" aria-label="Drop to add">
      <div className="drop-targets">
        <div className="drop-target" data-match={image ? 'true' : 'false'}>
          <UserFocus className="icon" aria-hidden="true" />
          <span className="label-caps">{image ? 'Release to use as reference' : 'Reference photo'}</span>
        </div>
        <div className="drop-target" data-match={folder ? 'true' : 'false'}>
          <FolderSimple className="icon" aria-hidden="true" />
          <span className="label-caps">{folder ? 'Release to use this folder' : 'Library folder'}</span>
        </div>
      </div>
    </div>
  )
}
