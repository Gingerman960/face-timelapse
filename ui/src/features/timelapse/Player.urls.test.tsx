// UI review 3, L5: the player rebuilt all frame URLs (3,600 strings) on every
// pixel of a window resize; they only change with the image-size bucket.
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { VideoSettings } from '../../ipc/contract'
import { makeFrames } from '../../test/session'

vi.mock('../../ipc/images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ipc/images')>()
  return { ...actual, alignedUrl: vi.fn(actual.alignedUrl) }
})
const { alignedUrl } = await import('../../ipc/images')
const { PlayerCanvas } = await import('./Player')

const video: VideoSettings = {
  pace: { mode: 'fps', fps: 30 },
  resolution: '1080p',
  quality: 'high',
  crossfade: { frames: 0, easing: 'linear' },
  caption: null,
  holdFirstSecs: 0,
  holdLastSecs: 1,
}
const frames = makeFrames(50)
const onion = { on: false, source: 'previous' as const, opacity: 0.5, difference: false }

function player(cssWidth: number) {
  return (
    <PlayerCanvas frames={frames} base="ftimg://localhost" cssWidth={cssWidth} aspect={3 / 4} onion={onion} anchors={false} referenceAnchors={null} referenceFrameUrl={null} video={video} label="Frame" />
  )
}

describe('player frame URLs', () => {
  it('are built once per width bucket, not once per pixel of a resize', () => {
    const { rerender } = render(player(400))
    const built = vi.mocked(alignedUrl).mock.calls.length
    expect(built).toBeGreaterThanOrEqual(frames.length)

    rerender(player(401))
    rerender(player(407))
    expect(vi.mocked(alignedUrl).mock.calls.length).toBe(built)

    rerender(player(1400))
    expect(vi.mocked(alignedUrl).mock.calls.length).toBeGreaterThan(built)
  })
})
