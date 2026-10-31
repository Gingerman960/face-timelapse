// Critique round 4, P1-5: the pen writes only the pick just made, in the calendar and the inspector.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import type { DayGroup } from '../../ipc/contract'
import { DayCell } from './DayCell'
import { JUST_DECIDED_MS, useJustDecided } from './justDecided'

const GROUP: DayGroup = { dayKey: '2014-05-02', photoIds: ['a', 'b'], selectedId: 'b', autoSelectedId: 'a', manualSelection: true, excluded: false }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  act(() => useJustDecided.setState({ day: null, photo: null }))
})

describe('the pick just made', () => {
  it('counts as just made for a moment, then is an ordinary pick', () => {
    act(() => useJustDecided.getState().mark('2014-05-02', 'b'))
    expect(useJustDecided.getState()).toMatchObject({ day: '2014-05-02', photo: 'b' })

    // A second pick restarts the moment.
    act(() => vi.advanceTimersByTime(JUST_DECIDED_MS - 100))
    act(() => useJustDecided.getState().mark('2014-05-03', 'c'))
    act(() => vi.advanceTimersByTime(JUST_DECIDED_MS - 100))
    expect(useJustDecided.getState().day).toBe('2014-05-03')
    act(() => vi.advanceTimersByTime(200))
    expect(useJustDecided.getState()).toMatchObject({ day: null, photo: null })
  })

  it('marks only its day cell for the pen', () => {
    const cell = (just: boolean) =>
      render(
        <DndContext>
          <DayCell dayKey="2014-05-02" group={GROUP} photo={undefined} base="" cellPx={30} selected={false} just={just} focusable inRange onSelect={() => undefined} />
        </DndContext>,
      ).container.querySelector('[role="gridcell"]')
    expect(cell(true)).toHaveAttribute('data-just', 'true')
    expect(cell(false)).not.toHaveAttribute('data-just')
  })
})
