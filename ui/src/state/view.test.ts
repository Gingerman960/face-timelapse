import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStores } from '../test/renderApp'
import { useView } from './view'

const view = () => useView.getState()

beforeEach(() => {
  resetStores()
  useView.setState({ toasts: [], reviewUndo: [] })
})

describe('view store', () => {
  it('toggles the sidebar and the inspector', () => {
    // Arrange
    const { sidebarCollapsed, inspectorOpen } = view()

    // Act
    view().toggleSidebar()
    view().toggleInspector()

    // Assert
    expect(view().sidebarCollapsed).toBe(!sidebarCollapsed)
    expect(view().inspectorOpen).toBe(!inspectorOpen)
  })

  it('stores simple flags as given', () => {
    // Act
    view().setSetupDragging(true)
    view().setAnchors(true)
    view().setDropActive(true)
    view().setExportOpen(true)

    // Assert
    expect(view()).toMatchObject({ setupDragging: true, anchors: true, dropActive: true, exportOpen: true })
  })

  it('never lets the review index go below zero', () => {
    // Act
    view().setReviewIndex(-4)

    // Assert
    expect(view().reviewIndex).toBe(0)
  })

  it('pops review undo entries last-in first-out and returns null when empty', () => {
    // Arrange
    view().pushReviewUndo({ ids: ['a'], previous: 'confirmed' })
    view().pushReviewUndo({ ids: ['b'], previous: 'rejected' })

    // Act
    const first = view().popReviewUndo()
    const second = view().popReviewUndo()
    const third = view().popReviewUndo()

    // Assert
    expect(first?.ids).toEqual(['b'])
    expect(second?.ids).toEqual(['a'])
    expect(third).toBeNull()
  })

  it('keeps only the three newest toasts and dismisses by id', () => {
    // Arrange
    const ids = [1, 2, 3, 4].map((n) => view().pushToast({ message: `t${n}`, tone: 'info' }))

    // Act
    view().dismissToast(ids[2] as number)

    // Assert
    expect(view().toasts.map((t) => t.message)).toEqual(['t2', 't4'])
  })
})

describe('inspector per screen (one store, one toggle)', () => {
  it('Reference and Days open with the inspector, Timelapse without (DESIGN), and each screen remembers its own', () => {
    useView.getState().setStep('setup')
    expect(useView.getState().inspectorOpen).toBe(true)
    useView.getState().setStep('timelapse')
    expect(useView.getState().inspectorOpen).toBe(false)
    useView.getState().toggleInspector()
    expect(useView.getState().inspectorOpen).toBe(true)
    useView.getState().setStep('days')
    expect(useView.getState().inspectorOpen).toBe(true)
    useView.getState().toggleInspector()
    useView.getState().setStep('timelapse')
    expect(useView.getState().inspectorOpen).toBe(true)
    useView.getState().setStep('days')
    expect(useView.getState().inspectorOpen).toBe(false)
  })
})

// UI review 2, L2: two moves to the same day gave identical toasts, and merging them lost the first Undo.
describe('toasts with an action', () => {
  it('never coalesce, so every Undo stays reachable', () => {
    useView.setState({ toasts: [] })
    const first = vi.fn()
    const second = vi.fn()
    useView.getState().pushToast({ message: 'Moved to 13 May 2014', tone: 'info', action: { label: 'Undo', run: first } })
    useView.getState().pushToast({ message: 'Moved to 13 May 2014', tone: 'info', action: { label: 'Undo', run: second } })
    const toasts = useView.getState().toasts
    expect(toasts).toHaveLength(2)
    toasts[0]?.action?.run()
    expect(first).toHaveBeenCalled()
  })
})
