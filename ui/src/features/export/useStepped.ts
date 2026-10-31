import { useEffect, useRef, useState } from 'react'

/**
 * `value`, stepped at most once every `everyMs` (critique round 5, P2-16: the
 * encoding print could swap its image on every progress event). The first
 * value passes at once; a change inside the interval waits for its end and
 * then steps to the latest value; a change after a quiet interval steps at
 * once. A value that comes back before its step is due causes no step.
 */
export function useStepped<T>(value: T, everyMs: number): T {
  const [shown, setShown] = useState(value)
  const lastStep = useRef<number | null>(null)
  useEffect(() => {
    lastStep.current ??= Date.now()
  }, [])
  useEffect(() => {
    if (Object.is(value, shown)) return
    const wait = Math.max(0, (lastStep.current ?? 0) + everyMs - Date.now())
    const timer = window.setTimeout(() => {
      lastStep.current = Date.now()
      setShown(value)
    }, wait)
    return () => window.clearTimeout(timer)
  }, [value, shown, everyMs])
  return shown
}
