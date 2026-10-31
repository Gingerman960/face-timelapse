import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Rect, ReferenceState } from '../../ipc/contract'
import { makeReference } from '../../test/session'
import { CropEditor } from './CropEditor'

/** The host is drawn at 1/10 of the 3200 px reference, so 1 CSS px is 10 image px. */
const HOST_WIDTH = 320
const CROP: Rect = { x: 746, y: 0, width: 1664, height: 2219 }

type EditorProps = Parameters<typeof CropEditor>[0]

function renderEditor(overrides: Partial<Omit<EditorProps, 'onDraft' | 'onDragChange'>> = {}) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: HOST_WIDTH, height: 237, right: HOST_WIDTH, bottom: 237, toJSON: () => ({}) } as DOMRect)
  const props = {
    reference: makeReference(),
    imageUrl: '/img/ref.jpg',
    crop: CROP,
    aspect: '3:4' as EditorProps['aspect'],
    stale: false,
    ...overrides,
    onDraft: vi.fn<(crop: Rect) => void>(),
    onDragChange: vi.fn<(dragging: boolean) => void>(),
  }
  const view = render(<CropEditor {...props} />)
  const crop = screen.getByRole('group', { name: /^Crop 1,664 by 2,219 pixels/ })
  return { ...view, props, crop }
}

describe('CropEditor', () => {
  it('shows the reference print, the crop size and the face template', () => {
    // Act
    const { container, crop } = renderEditor()

    // Assert
    expect(screen.getByRole('img', { name: 'Reference photo IMG_20140815_142326.jpg' })).toHaveAttribute('src', '/img/ref.jpg')
    expect(crop).toHaveTextContent('1664 × 2219 px')
    expect(crop).not.toHaveAttribute('data-noface')
    expect(container.querySelector('svg.template')).not.toBeNull()
    expect(container.querySelectorAll('.anchor')).toHaveLength(5)
    expect(container.querySelectorAll('.anchor.minor')).toHaveLength(3)
    expect((container.querySelector('.crop-host') as HTMLElement).style.getPropertyValue('--w')).toBe(String(1664 / 3200))
  })

  it('dragging the frame moves the crop in image pixels', () => {
    // Arrange
    const { crop, props } = renderEditor()

    // Act
    fireEvent.pointerDown(crop, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(crop, { pointerId: 1, clientX: 110, clientY: 103 })
    fireEvent.pointerUp(crop, { pointerId: 1, clientX: 110, clientY: 103 })

    // Assert
    expect(props.onDragChange).toHaveBeenNthCalledWith(1, true)
    expect(props.onDraft).toHaveBeenCalledWith({ ...CROP, x: 846, y: 30 })
    expect(props.onDragChange).toHaveBeenLastCalledWith(false)
  })

  it('dragging a corner resizes the crop at the locked aspect', () => {
    // Arrange
    const { container, props } = renderEditor()
    const corner = container.querySelector('.corner.nw') as HTMLElement

    // Act
    fireEvent.pointerDown(corner, { button: 0, pointerId: 2, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(corner, { pointerId: 2, clientX: 30, clientY: 40 })
    fireEvent.pointerCancel(corner, { pointerId: 2 })

    // Assert
    const draft = props.onDraft.mock.lastCall?.[0] as Rect
    expect(draft.width).toBeLessThan(CROP.width)
    expect(draft.width / draft.height).toBeCloseTo(3 / 4, 2)
    expect(draft.x + draft.width).toBe(CROP.x + CROP.width)
    expect(props.onDragChange).toHaveBeenLastCalledWith(false)
  })

  it('dragging an edge resizes from that edge', () => {
    // Arrange
    const { container, props } = renderEditor({ aspect: 'free' })
    const edge = container.querySelector('.edge-hit.e') as HTMLElement

    // Act
    fireEvent.pointerDown(edge, { button: 0, pointerId: 3, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(edge, { pointerId: 3, clientX: -20, clientY: 0 })

    // Assert
    expect(props.onDraft).toHaveBeenLastCalledWith({ ...CROP, width: CROP.width - 200 })
  })

  it('ignores secondary buttons and moves without a drag, and releases a held capture', () => {
    // Arrange
    const { crop, props } = renderEditor()
    const release = vi.spyOn(Element.prototype, 'releasePointerCapture')
    vi.spyOn(Element.prototype, 'hasPointerCapture').mockReturnValue(true)

    // Act
    fireEvent.pointerDown(crop, { button: 2, pointerId: 4, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(crop, { pointerId: 4, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(crop, { pointerId: 4 })
    const quiet = props.onDraft.mock.calls.length + props.onDragChange.mock.calls.length
    fireEvent.pointerDown(crop, { button: 0, pointerId: 5, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(crop, { pointerId: 5 })

    // Assert
    expect(quiet).toBe(0)
    expect(release).toHaveBeenCalledWith(5)
  })

  it('without a face it warns inside the crop', () => {
    // Act
    const { crop, container } = renderEditor({ reference: makeReference({ detection: null }) })

    // Assert
    expect(crop).toHaveAttribute('data-noface', 'true')
    expect(crop).toHaveTextContent('No face inside the crop')
    expect(container.querySelector('svg.template')).toBeNull()
  })

  it('while stale it shows thirds instead of the template and no face warning', () => {
    // Act
    const { crop, container } = renderEditor({ stale: true, reference: makeReference({ detection: null }) })

    // Assert
    expect(container.querySelector('.thirds')).not.toBeNull()
    expect(crop).not.toHaveAttribute('data-noface')
  })

  it('draws no template when the eyes are missing, and skips missing minor anchors', () => {
    // Arrange
    const base = makeReference()
    const twoEyes: ReferenceState = { ...base, detection: { ...base.detection!, anchors: base.detection!.anchors.slice(0, 2) } }
    const oneEye: ReferenceState = { ...base, detection: { ...base.detection!, anchors: base.detection!.anchors.slice(0, 1) } }

    // Act
    const { container, rerender, props } = renderEditor({ reference: twoEyes })
    const withTwo = container.querySelectorAll('.anchor').length
    rerender(<CropEditor {...props} reference={oneEye} />)

    // Assert
    expect(withTwo).toBe(2)
    expect(container.querySelector('svg.template')).toBeNull()
  })
})
