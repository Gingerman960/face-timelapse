import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { FrameSummary, Point, VideoSettings } from '../../ipc/contract'
import { ALIGNED_WIDTHS } from '../../ipc/contract'
import { alignedUrl, bucketWidth } from '../../ipc/images'
import type { PlanFrame } from '../../lib/video'
import { usePlayer } from '../../state/player'
import { RetryImg } from '../../components/ui/RetryImg'
import { useTransitionHold } from '../shell/stepTransition'
import { decodedFrameBytes, type FrameBuffer } from './frameBuffer'
import { stillOf } from './playback'
import { useFrameBuffer, useFrameWindow, usePlaybackLoop, usePlaybackPlan } from './usePlayback'

export interface OnionSettings {
  on: boolean
  source: 'previous' | 'reference'
  opacity: number
  difference: boolean
}

interface PlayerCanvasProps {
  frames: readonly FrameSummary[]
  base: string
  /** CSS width the frame is shown at (picks the image width bucket). */
  cssWidth: number
  /** Frame width ÷ height (sizes the decoded-bytes budget). */
  aspect: number
  onion: OnionSettings
  anchors: boolean
  referenceAnchors: Point[] | null
  referenceFrameUrl: string | null
  /** The video settings in effect: playback walks the export's own timeline at its pace. */
  video: VideoSettings
  label: string
}

type FrameStatus = 'ready' | 'loading' | 'failed'

interface Layers {
  base: CanvasImageSource
  blend: { img: CanvasImageSource; t: number } | null
  overlay: { img: CanvasImageSource; difference: boolean; opacity: number } | null
}

/** Paints one output frame: the photo, the blend toward the next one, then the onion overlay. */
export function paintLayers(ctx: CanvasRenderingContext2D, w: number, h: number, { base, blend, overlay }: Layers): void {
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.drawImage(base, 0, 0, w, h)
  if (blend) {
    ctx.globalAlpha = blend.t
    ctx.drawImage(blend.img, 0, 0, w, h)
  }
  if (overlay) {
    ctx.globalCompositeOperation = overlay.difference ? 'difference' : 'source-over'
    ctx.globalAlpha = overlay.difference ? 1 : overlay.opacity
    ctx.drawImage(overlay.img, 0, 0, w, h)
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

/** True when the player may show `url`: decoded, or failed (skipped, never waited for). */
function passable(buffer: FrameBuffer, url: string): boolean {
  return buffer.get(url) !== null || buffer.failed(url)
}

/** Whether a paused frame is on screen, still decoding, or failed to load. */
function statusOf(buffer: FrameBuffer, url: string): FrameStatus {
  if (buffer.get(url)) return 'ready'
  return buffer.failed(url) ? 'failed' : 'loading'
}

/**
 * Gives the canvas's backing store back when the player unmounts or Suspense
 * hides it (HIGH-3); the next draw sizes it again.
 */
function useReleaseCanvas(canvas: RefObject<HTMLCanvasElement | null>): void {
  useLayoutEffect(() => {
    const c = canvas.current
    return () => {
      if (!c) return
      c.width = 0
      c.height = 0
    }
  }, [canvas])
}

function useBoxSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  return { ref, size }
}

/** Reference template lines through the eye midpoint (onion skin). */
function Template({ anchors }: { anchors: Point[] | null }) {
  const [l, r] = anchors ?? []
  return (
    <svg className="template" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      {l && r ? (
        <>
          <line x1={0} y1={(l.y + r.y) / 2} x2={1} y2={(l.y + r.y) / 2} />
          <line x1={(l.x + r.x) / 2} y1={0} x2={(l.x + r.x) / 2} y2={1} />
        </>
      ) : null}
    </svg>
  )
}

/**
 * The photo the poster shows: the paused playhead, held while playing (the
 * canvas draws over it then), so playback never loads it again.
 */
function usePosterIndex(stillIndex: number, count: number): number {
  const [at, setAt] = useState(() => Math.max(0, Math.min(usePlayer.getState().index, count - 1)))
  if (stillIndex >= 0 && stillIndex !== at) setAt(stillIndex)
  return at
}

/**
 * A poster of the frame on show under the canvas (critique round 5, P1-2): a
 * View Transition into the player captures a picture, never sunken fill, even
 * before the ring buffer has decoded a frame. A transition running while the
 * player mounts waits for the poster to decode (useTransitionHold, at most
 * HOLD_CAP_MS); a poster that fails to load holds nothing.
 */
function Poster({ src }: { src: string }) {
  const img = useRef<HTMLImageElement>(null)
  const [painted, setPainted] = useState(false)
  useTransitionHold(!painted)
  const done = useCallback(() => setPainted(true), [])
  useLayoutEffect(() => {
    const el = img.current
    if (!el || !src || typeof el.decode !== 'function') return
    let live = true
    const settle = () => {
      if (live) done()
    }
    el.decode().then(settle, settle)
    return () => {
      live = false
    }
  }, [src, done])
  if (!src) return null
  return <RetryImg ref={img} src={src} className="frame-poster" alt="" aria-hidden="true" draggable={false} onLoad={done} onError={done} />
}

function OnionLegend({ onion }: { onion: OnionSettings }) {
  const what = onion.source === 'reference' ? 'reference' : 'previous day'
  const how = onion.difference ? '(difference)' : `at ${Math.round(onion.opacity * 100)}%`
  return (
    <span className="onion-legend">
      Onion skin: {what} {how}
    </span>
  )
}

/**
 * Canvas player: draws decoded frames from a ring buffer and plays the
 * export's output timeline (crossfades and holds included) at the export's
 * frame rate × the shuttle rate. It holds (never skips) while the next frame decodes,
 * skips frames that failed to load, and shows a placeholder when paused on one.
 */
export function PlayerCanvas({ frames, base, cssWidth, aspect, onion, anchors, referenceAnchors, referenceFrameUrl, video, label }: PlayerCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const { ref: box, size } = useBoxSize()
  const playing = usePlayer((s) => s.playing)
  // Clamped: the frames can shrink under a paused playhead (UI review 2, H4).
  const stillIndex = usePlayer((s) => (s.playing ? -1 : Math.min(s.index, frames.length - 1)))
  const dpr = window.devicePixelRatio || 1
  // Built once per frames list and image-size bucket: not on every display frame
  // (UI review 2, L6), nor on every pixel of a window resize (UI review 3, L5).
  const bucket = bucketWidth(ALIGNED_WIDTHS, cssWidth, dpr)
  const urls = useMemo(() => frames.map((f) => alignedUrl(base, { photoId: f.photoId, version: f.version }, bucket, 1)), [frames, base, bucket])
  const urlOf = useCallback((i: number) => urls[i] ?? '', [urls])
  const buffer = useFrameBuffer()
  // The reference frame is decoded only while the onion skin shows it (HIGH-3).
  const overlayReference = onion.on && onion.source === 'reference' ? referenceFrameUrl : null
  // Nothing is fetched until the frame's width is known (L7).
  useFrameWindow(buffer, cssWidth > 0 ? frames.length : 0, urlOf, overlayReference, decodedFrameBytes(bucketWidth(ALIGNED_WIDTHS, cssWidth, dpr), aspect))
  useReleaseCanvas(canvas)
  const { plan, fps } = usePlaybackPlan(frames.length, video)

  const canShow = useCallback(
    (f: PlanFrame) => passable(buffer, urlOf(f.a)) && (f.b === null || passable(buffer, urlOf(f.b))),
    [buffer, urlOf],
  )

  const draw = useCallback(
    (frame: PlanFrame) => {
      const url = urlOf(frame.a)
      const img = buffer.get(url)
      const c = canvas.current
      const ctx = c && size.w > 0 ? c.getContext('2d') : null
      // Not laid out yet: nothing painted, so the loop tries again (UI review 3, L3).
      if (!c || !ctx) return false
      const w = Math.round(size.w * dpr)
      const h = Math.round(size.h * dpr)
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      // While playing, a failed frame is skipped: the previous picture stays up.
      if (!img) {
        if (buffer.failed(url) && !usePlayer.getState().playing) ctx.clearRect(0, 0, w, h)
        // A failed frame is done with; one still decoding is drawn when it arrives.
        return buffer.failed(url)
      }
      const next = frame.b !== null && frame.t > 0 ? buffer.get(urlOf(frame.b)) : null
      const overlayUrl = onion.source === 'reference' && referenceFrameUrl ? referenceFrameUrl : urlOf(frame.a - 1)
      const overlay = onion.on ? buffer.get(overlayUrl) : null
      paintLayers(ctx, w, h, {
        base: img,
        blend: next ? { img: next, t: frame.t } : null,
        overlay: overlay ? { img: overlay, difference: onion.difference, opacity: onion.opacity } : null,
      })
      return true
    },
    [size, dpr, buffer, urlOf, onion, referenceFrameUrl],
  )

  usePlaybackLoop(playing, { plan, fps, canShow, draw })
  useEffect(() => {
    if (stillIndex >= 0) draw(stillOf(stillIndex))
  })
  // Paused: re-rendered on every decode, so this reflects the buffer. Playing: the loop never waits on a frame.
  const status: FrameStatus = stillIndex >= 0 ? statusOf(buffer, urlOf(stillIndex)) : 'ready'
  const posterAt = usePosterIndex(stillIndex, frames.length)

  return (
    <div ref={box} className="frame-canvas" style={{ position: 'absolute', inset: 0 }}>
      <Poster src={cssWidth > 0 ? urlOf(posterAt) : ''} />
      <canvas ref={canvas} role="img" aria-label={label} />
      {onion.on ? <Template anchors={referenceAnchors} /> : null}
      {anchors && referenceAnchors ? (
        <svg className="anchors" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          {referenceAnchors.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={i < 2 ? 0.009 : 0.006} />
          ))}
        </svg>
      ) : null}
      {onion.on ? <OnionLegend onion={onion} /> : null}
      {status === 'failed' ? <p className="frame-failed">This frame couldn’t be loaded.</p> : null}
      {status === 'loading' ? <i className="indeterminate buffering" aria-label="Loading frame" /> : null}
    </div>
  )
}
