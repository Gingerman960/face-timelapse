import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/**
 * Width the element lays out at (CSS px), read before the first paint and
 * followed through resizes; 0 until then, so callers wait rather than fetch
 * images at a guessed width (UI review 2, L7).
 */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setWidth(el.clientWidth)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, width }
}

/**
 * The element's content width (inside its padding), read synchronously before
 * the first paint and followed through resizes; 0 until the element is laid out.
 */
export function useContentWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const style = getComputedStyle(el)
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
      setWidth(Math.max(0, el.clientWidth - padding))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}
