// QA 1: a Days thumbnail the image server refused (503 while a whole year loads) must load again on its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import type { DayGroup, FrameSummary, PhotoSummary } from '../../ipc/contract'
import { RETRY_DELAYS_MS } from '../../components/ui/RetryImg'
import { DayCell, FaceThumb } from './DayCell'

const PHOTO: PhotoSummary = {
  id: '0123456789abcdef',
  fileName: 'IMG_20140502_084100.jpg',
  relPath: '2014/IMG_20140502_084100.jpg',
  takenAt: '2014-05-02T08:41:00',
  dateSource: 'exif',
  timeKnown: true,
  dayKey: '2014-05-02',
  score: 0.91,
  status: 'confirmed',
  review: 'pending',
  included: true,
  size: { width: 3200, height: 2400 },
  faceBox: { x: 0.4, y: 0.3, width: 0.2, height: 0.3 },
  version: '5d0c9e8b',
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('FaceThumb', () => {
  it('retries a thumbnail that failed to load', () => {
    // Arrange
    const { container } = render(<FaceThumb photo={PHOTO} base="http://ftimg.localhost/" cellPx={30} />)
    const img = () => container.querySelector('img') as HTMLImageElement
    const first = img().getAttribute('src') as string

    // Act
    fireEvent.error(img())
    act(() => {
      vi.advanceTimersByTime(RETRY_DELAYS_MS[0] ?? 0)
    })

    // Assert
    expect(first).toMatch(/\/thumb\/0123456789abcdef\?w=\d+&v=5d0c9e8b$/)
    expect(img().getAttribute('src')).toBe(`${first}&r=1`)
  })
})

// Critique round 5, P1-2: only the selected day carries the print that travels into the player.
describe('DayCell and the transition print', () => {
  const FRAME = { photoId: PHOTO.id, dayKey: PHOTO.dayKey, version: 'f1' } as unknown as FrameSummary
  const GROUP = { dayKey: PHOTO.dayKey, photoIds: [PHOTO.id], selectedId: PHOTO.id, manualSelection: false, excluded: false } as unknown as DayGroup
  const cell = (selected: boolean) =>
    render(
      <DayCell dayKey={PHOTO.dayKey} group={GROUP} photo={PHOTO} frame={FRAME} base="http://ftimg.localhost/" cellPx={30} selected={selected} focusable inRange onSelect={() => undefined} />,
    ).container

  it('the selected day carries its aligned frame, named by its day', () => {
    const print = cell(true).querySelector('[data-vt-print]') as HTMLElement
    expect(print.style.getPropertyValue('--vt-print')).toBe(`ft-day-${PHOTO.dayKey}`)
  })

  it('other days carry none, so every name is unique', () => {
    expect(cell(false).querySelector('[data-vt-print]')).toBeNull()
  })
})
