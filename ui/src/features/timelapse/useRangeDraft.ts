import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react'

/** Idle time after the last change before a range commits on its own (no release event seen). */
export const RANGE_COMMIT_MS = 200

export interface RangeDraftProps {
  value: number
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  onPointerUp: () => void
  onKeyUp: () => void
  onBlur: () => void
}

/**
 * A range input that keeps a local draft while it is dragged and commits once:
 * on pointer or key release, on blur, after RANGE_COMMIT_MS without changes,
 * or when it unmounts. The draft stays on screen until the commit settles, so
 * the thumb does not jump back while the new value travels. `commit` handles
 * its own errors; a returned promise is only waited for.
 */
export function useRangeDraft(committed: number, commit: (value: number) => unknown, delayMs = RANGE_COMMIT_MS): RangeDraftProps {
  const [draft, setDraft] = useState<number | null>(null)
  const pending = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seq = useRef(0)
  const commitRef = useRef(commit)
  useLayoutEffect(() => {
    commitRef.current = commit
  })

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const value = pending.current
    if (value === null) return
    pending.current = null
    seq.current += 1
    const mine = seq.current
    void Promise.resolve(commitRef.current(value))
      .catch(() => undefined)
      .then(() => {
        if (seq.current === mine && pending.current === null) setDraft(null)
      })
  }, [])

  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.currentTarget.value)
      pending.current = value
      setDraft(value)
      clearTimeout(timer.current)
      timer.current = setTimeout(flush, delayMs)
    },
    [flush, delayMs],
  )

  useEffect(() => () => flush(), [flush])

  return { value: draft ?? committed, onChange, onPointerUp: flush, onKeyUp: flush, onBlur: flush }
}
