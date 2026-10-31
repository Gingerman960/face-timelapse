import { useCallback, useEffect, useRef, useState } from 'react'
import type { AspectPreset, IpcError, Rect } from '../../ipc/contract'
import { toIpcError } from '../../ipc/client'
import { setReferenceCrop } from '../../state/actions'

/** A drag or nudge commits this long after it ends (DESIGN: 150 ms). */
export const COMMIT_DELAY_MS = 150

export interface CropDraft {
  /** The uncommitted crop shown while dragging or nudging, else null. */
  draft: Rect | null
  /** The newest draft right now, ahead of a render (a pointerup can arrive before the last move rendered). */
  latest: () => Rect | null
  /** True while a commit is in flight. */
  pending: boolean
  error: IpcError | null
  setDraft: (rect: Rect | null) => void
  setError: (error: IpcError | null) => void
  /** Commits now (cancelling a scheduled commit); true when the backend took it. */
  commit: (rect: Rect, aspect: AspectPreset) => Promise<boolean>
  /** Shows `rect` at once and commits it after COMMIT_DELAY_MS of quiet. */
  schedule: (rect: Rect) => void
  /** Commits a scheduled draft now (before an edit that builds on the crop); true when nothing failed. */
  flush: () => Promise<boolean>
}

/** The optimistic crop: drafts while editing, one commit after the edit settles. */
export function useCropDraft(aspect: AspectPreset): CropDraft {
  const [draft, setDraftState] = useState<Rect | null>(null)
  const latestDraft = useRef<Rect | null>(null)
  const setDraft = useCallback((rect: Rect | null) => {
    latestDraft.current = rect
    setDraftState(rect)
  }, [])
  /** Drops `rect` once it is committed, but never a newer draft made while it travelled (UI review 2, H2). */
  const settle = useCallback((rect: Rect) => {
    if (latestDraft.current === rect) latestDraft.current = null
    setDraftState((d) => (d === rect ? null : d))
  }, [])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<IpcError | null>(null)
  const timer = useRef<number | undefined>(undefined)
  /** The draft the timer will commit. */
  const scheduled = useRef<Rect | null>(null)

  const cancelTimer = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    scheduled.current = null
  }, [])

  const commit = useCallback(
    async (rect: Rect, nextAspect: AspectPreset) => {
      // A nudge waiting for its commit is superseded by this one: drop its draft
      // with its timer, so it is never left on screen unsent (UI review 3, M3).
      const superseded = scheduled.current
      cancelTimer()
      if (superseded && superseded !== rect) settle(superseded)
      setPending(true)
      setError(null)
      try {
        await setReferenceCrop(rect, nextAspect)
        return true
      } catch (e) {
        setError(toIpcError(e))
        return false
      } finally {
        settle(rect)
        setPending(false)
      }
    },
    [cancelTimer, settle],
  )

  const schedule = useCallback(
    (rect: Rect) => {
      setDraft(rect)
      cancelTimer()
      scheduled.current = rect
      timer.current = window.setTimeout(() => void commit(rect, aspect), COMMIT_DELAY_MS)
    },
    [cancelTimer, commit, aspect, setDraft],
  )

  const flush = useCallback(() => {
    const rect = scheduled.current
    return rect ? commit(rect, aspect) : Promise.resolve(true)
  }, [commit, aspect])

  useEffect(() => cancelTimer, [cancelTimer])
  const latest = useCallback(() => latestDraft.current, [])
  return { draft, latest, pending, error, setDraft, setError, commit, schedule, flush }
}
