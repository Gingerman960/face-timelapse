import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ImgHTMLAttributes, type Ref, type RefObject, type SyntheticEvent } from 'react'

/**
 * Backoff before each retry of a failed image. The image server may shed
 * load with 503 while a whole year of thumbnails is requested at once; a few
 * spaced retries recover those, a hard limit keeps a truly broken image from
 * spinning forever.
 */
export const RETRY_DELAYS_MS: readonly number[] = [400, 1200, 3000]

/** Adds `r=<attempt>` (ignored by the ftimg server) so the webview asks again instead of reusing the failure. */
export function withRetryParam(src: string, attempt: number): string {
  if (attempt === 0) return src
  return `${src}${src.includes('?') ? '&' : '?'}r=${attempt}`
}

/*
 * One shared IntersectionObserver for every RetryImg (a year view mounts ~365
 * thumbnails). Each image registers a callback; the observer goes away when
 * the last image unregisters.
 */
type VisibilityListener = (visible: boolean) => void
const listeners = new Map<Element, VisibilityListener>()
let shared: IntersectionObserver | null = null

function watchVisibility(el: Element, listener: VisibilityListener): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => undefined
  shared ??= new IntersectionObserver((entries) => {
    for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting)
  })
  listeners.set(el, listener)
  shared.observe(el)
  return () => {
    listeners.delete(el)
    shared?.unobserve(el)
    if (listeners.size === 0) {
      shared?.disconnect()
      shared = null
    }
  }
}

/**
 * Gives `img` its source in a layout effect, and takes it away only on unmount
 * (N3). WebKit keeps a removed image's decoded bitmap, and its cache entry,
 * live until the element is garbage-collected, which can be long after a year
 * of Days thumbnails left the screen; without a source it lets go at once.
 * A new source is a plain swap (UI review 2, H1): the old picture stays until
 * the new one has loaded, where removing it first painted the background in
 * between. Setting the source here rather than as a prop keeps StrictMode
 * safe: its mount, unmount, mount runs both setups again after both cleanups.
 * A layout effect sets it before the first paint, after the `loading` hint.
 */
function useImageSource(img: RefObject<HTMLImageElement | null>, src: string): void {
  useLayoutEffect(() => {
    img.current?.setAttribute('src', src)
  }, [img, src])
  useLayoutEffect(() => {
    const node = img.current
    // No `src` at all (not ""): the browser drops the image without an error event.
    return () => node?.removeAttribute('src')
  }, [img])
}

interface RetryImgProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src: string
  ref?: Ref<HTMLImageElement>
}

interface LoadState {
  src: string
  attempt: number
  failed: boolean
}

/**
 * An `<img>` that retries a failed load with backoff, only while it is
 * mounted and on screen (an off-screen cell waits until it scrolls back into
 * view). After the last attempt it gives up and hides the browser's broken
 * image icon (`data-failed`), leaving the cell's own background.
 */
export function RetryImg({ src, ref, onError, onLoad, ...rest }: RetryImgProps) {
  const [state, setState] = useState<LoadState>({ src, attempt: 0, failed: false })
  if (state.src !== src) setState({ src, attempt: 0, failed: false })
  const el = useRef<HTMLImageElement>(null)
  useImperativeHandle(ref, () => el.current as HTMLImageElement, [])
  const visible = useRef(true)
  const pending = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const retryNow = useCallback(() => {
    pending.current = false
    setState((s) => (s.attempt < RETRY_DELAYS_MS.length ? { ...s, attempt: s.attempt + 1 } : s))
  }, [])

  useEffect(() => {
    const node = el.current
    if (!node) return
    return watchVisibility(node, (isVisible) => {
      visible.current = isVisible
      if (isVisible && pending.current) retryNow()
    })
  }, [retryNow])

  // A new source (or unmounting) cancels any retry scheduled for the old one.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      pending.current = false
    },
    [src],
  )

  const handleError = (e: SyntheticEvent<HTMLImageElement>) => {
    onError?.(e)
    const delay = RETRY_DELAYS_MS[state.attempt]
    if (delay === undefined) {
      setState((s) => ({ ...s, failed: true }))
      return
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      if (visible.current) retryNow()
      else pending.current = true
    }, delay)
  }

  const handleLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    onLoad?.(e)
    if (state.failed) setState((s) => ({ ...s, failed: false }))
  }

  useImageSource(el, withRetryParam(src, state.attempt))

  return (
    <img
      ref={el}
      data-failed={state.failed ? 'true' : undefined}
      onError={handleError}
      onLoad={handleLoad}
      {...rest}
    />
  )
}
