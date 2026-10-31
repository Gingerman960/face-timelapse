import { describe, expect, it } from 'vitest'
import type { Active, Over } from '@dnd-kit/core'
import { DRAG_ANNOUNCEMENTS, dropUnderPointer } from './useDayDrag'

const active = (data?: { photoId: string; from: string }) => ({ id: 'p1', data: { current: data } }) as unknown as Active
const over = (dayKey?: string) => ({ id: dayKey ?? 'x', data: { current: dayKey ? { dayKey } : undefined } }) as unknown as Over

describe('drag announcements', () => {
  const photo = { photoId: 'p1', from: '2014-05-02' }

  it('names days instead of raw ids', () => {
    expect(DRAG_ANNOUNCEMENTS.onDragStart({ active: active(photo) })).toBe('Picked up the photo from 2 May 2014.')
    expect(DRAG_ANNOUNCEMENTS.onDragOver({ active: active(photo), over: over('2014-05-10') })).toBe('Over 10 May 2014.')
    expect(DRAG_ANNOUNCEMENTS.onDragEnd({ active: active(photo), over: over('2014-05-10') })).toBe('Moving to 10 May 2014.')
    expect(DRAG_ANNOUNCEMENTS.onDragCancel({ active: active(photo), over: null })).toBe('Move cancelled.')
  })

  it('says nothing moved for a drop on the same day or outside the calendar', () => {
    expect(DRAG_ANNOUNCEMENTS.onDragEnd({ active: active(photo), over: over('2014-05-02') })).toBe('Nothing moved.')
    expect(DRAG_ANNOUNCEMENTS.onDragEnd({ active: active(photo), over: null })).toBe('Nothing moved.')
    expect(DRAG_ANNOUNCEMENTS.onDragStart({ active: active() })).toBeUndefined()
    expect(DRAG_ANNOUNCEMENTS.onDragOver({ active: active(photo), over: over() })).toBeUndefined()
  })
})

describe('dropUnderPointer (QA HIGH: drop on the cell under the pointer)', () => {
  const rect = (left: number, top: number, w = 30, h = 30) => ({ left, top, width: w, height: h, right: left + w, bottom: top + h })
  const containers = ['2012-09-04', '2012-09-13'].map((id) => ({ id, key: id, data: { current: { dayKey: id } }, disabled: false, node: { current: null }, rect: { current: null } }))
  const droppableRects = new Map([
    ['2012-09-04', rect(0, 0)],
    ['2012-09-13', rect(200, 0)],
  ])
  const base = {
    active: { id: 'p1', data: { current: {} }, rect: { current: { initial: null, translated: null } } },
    // The dragged row is wide and mostly over 4 Sep…
    collisionRect: rect(-20, 0, 272, 85),
    droppableContainers: containers,
    droppableRects,
  }

  it('picks the cell under the pointer, not the one the dragged row overlaps most', () => {
    const hits = dropUnderPointer({ ...base, pointerCoordinates: { x: 215, y: 15 } } as unknown as Parameters<typeof dropUnderPointer>[0])
    expect(hits[0]?.id).toBe('2012-09-13')
  })

  it('without a pointer (keyboard) falls back to the nearest centre', () => {
    const hits = dropUnderPointer({ ...base, collisionRect: rect(190, 0), pointerCoordinates: null } as unknown as Parameters<typeof dropUnderPointer>[0])
    expect(hits[0]?.id).toBe('2012-09-13')
  })
})
