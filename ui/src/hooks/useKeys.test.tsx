import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { isMod, isTypingTarget, runPrimaryAction, useKeydown, usePrimaryAction } from './useKeys'
import { readStored, storedLastStep, useView, writeStored } from '../state/view'

function KeyProbe({ onKey, action }: { onKey: (e: KeyboardEvent) => void; action: (() => void) | null }) {
  useKeydown(onKey)
  usePrimaryAction(action)
  return <input aria-label="field" />
}

describe('keyboard plumbing', () => {
  it('ignores typing targets and modal sheets', () => {
    const onKey = vi.fn()
    const { getByLabelText } = render(<KeyProbe onKey={onKey} action={null} />)
    fireEvent.keyDown(window, { key: 'y' })
    expect(onKey).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(getByLabelText('field'), { key: 'y' })
    expect(onKey).toHaveBeenCalledTimes(1)
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    fireEvent.keyDown(window, { key: 'y' })
    expect(onKey).toHaveBeenCalledTimes(1)
    modal.remove()
  })

  it('runs the mounted screen primary action', () => {
    const action = vi.fn()
    const { unmount } = render(<KeyProbe onKey={() => undefined} action={action} />)
    expect(runPrimaryAction()).toBe(true)
    expect(action).toHaveBeenCalled()
    unmount()
    expect(runPrimaryAction()).toBe(false)
  })

  // QA LOW: ⌘↩ in the export sheet must work wherever focus is while the sheet is open.
  it('stacks primary actions: a sheet’s action wins while it is open, the screen’s comes back after', () => {
    const screenAction = vi.fn()
    const sheetAction = vi.fn()
    function Sheet() {
      usePrimaryAction(sheetAction, { modal: true })
      return null
    }
    const screen = render(<KeyProbe onKey={() => undefined} action={screenAction} />)
    const sheet = render(<Sheet />)

    expect(runPrimaryAction({ modal: true })).toBe(true)
    expect(sheetAction).toHaveBeenCalledTimes(1)
    expect(screenAction).not.toHaveBeenCalled()

    sheet.unmount()
    expect(runPrimaryAction({ modal: true })).toBe(false)
    expect(runPrimaryAction()).toBe(true)
    expect(screenAction).toHaveBeenCalledTimes(1)
    screen.unmount()
  })

  it('classifies typing targets and the platform modifier', () => {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    expect(isTypingTarget(cb)).toBe(false)
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true)
    expect(isTypingTarget(null)).toBe(false)
    expect(typeof isMod({ metaKey: true, ctrlKey: false })).toBe('boolean')
  })
})

describe('view store', () => {
  it('persists theme and last step, and keeps transient steps out of storage', () => {
    useView.getState().setTheme('dark')
    expect(readStored('ft.theme')).toBe('dark')
    useView.getState().setStep('days')
    expect(storedLastStep()).toBe('days')
    useView.getState().setStep('scan')
    expect(storedLastStep()).toBe('days')
    writeStored('ft.lastStep', 'bogus')
    expect(storedLastStep()).toBeNull()
  })
  it('keeps at most three toasts and an undo stack', () => {
    const v = useView.getState()
    for (let i = 0; i < 5; i++) v.pushToast({ message: `t${i}`, tone: 'info' })
    expect(useView.getState().toasts.map((t) => t.message)).toEqual(['t2', 't3', 't4'])
    v.dismissToast(useView.getState().toasts[0]?.id ?? -1)
    expect(useView.getState().toasts).toHaveLength(2)
    v.pushReviewUndo({ ids: ['a'], previous: 'pending' })
    expect(useView.getState().popReviewUndo()).toEqual({ ids: ['a'], previous: 'pending' })
    expect(useView.getState().popReviewUndo()).toBeNull()
  })
})
