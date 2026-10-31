import { useCallback, useMemo, useState } from 'react'
import { DndContext, DragOverlay } from '@dnd-kit/core'
import { dropSettle } from './dropSettle'
import type { DayKey, RenderSettings } from '../../ipc/contract'
import { usePrimaryAction } from '../../hooks/useKeys'
import { reportError } from '../../state/actions'
import { startAlign, useJobs } from '../../state/jobs'
import { useModelsBlock } from '../../state/models'
import { useView } from '../../state/view'
import { useFrames } from '../../state/queries'
import { usePlayer } from '../../state/player'
import { Screen } from '../shell/Screen'
import type { ViewProps, VisibleSpan } from './CalendarViews'
import { DayInspector } from './DayInspector'
import { DaysCanvas, DragGhost } from './DaysCanvas'
import { DaysRibbon } from './DaysRibbon'
import { DaysTools, ZoomControls } from './DaysToolbar'
import { clampDay, clampYear, monthDays, shiftMonth, shiftMonthKeepDay, yearOf } from './daysModel'
import { useDayActions } from './useDayActions'
import { useDayRun } from './useDayRun'
import { runActionLabel, runCount, runLabel } from './dayRun'
import { DRAG_ANNOUNCEMENTS, useDayDrag } from './useDayDrag'
import { useDaysData, useDaysView, useLanding } from './useDaysData'
import { useDaysKeys } from './useDaysKeys'
import { useMoveMode } from './useMoveMode'
import './days.css'

const TITLE = 'Days'
const SUBTITLE = 'One photo for every day'
/** Shown before any day exists (an empty library). */
const FALLBACK_DAY: DayKey = '2014-01-01'
const MONTHS_PER_YEAR = 12
/** A month's first and last day. */
function monthSpan(day: DayKey): VisibleSpan {
  const days = monthDays(yearOf(day), Number(day.slice(5, 7)))
  return { start: days[0] ?? day, end: days[days.length - 1] ?? day }
}

const DRAG_ACCESSIBILITY = {
  announcements: DRAG_ANNOUNCEMENTS,
  screenReaderInstructions: { draggable: 'Drag the photo onto another day. With the keyboard, press M to move the chosen photo.' },
}

/** Days: one photo for every day, a calendar of faces. */
export default function DaysScreen() {
  const { session, info, days, index, range, photoMap, sets } = useDaysData()
  const { activeDay, daysZoom, daysYear, setActiveDay, setDaysZoom, setDaysYear } = useDaysView()
  const inspectorOpen = useView((s) => s.inspectorOpen)
  const toggleInspector = useView((s) => s.toggleInspector)
  const busy = useJobs((s) => s.activeJobId !== null)
  const select = useCallback(
    (d: DayKey) => {
      setActiveDay(d)
      setDaysYear(yearOf(d))
    },
    [setActiveDay, setDaysYear],
  )
  useLanding(days, activeDay, select)

  const day = activeDay ?? index.last ?? FALLBACK_DAY
  const group = index.byDay.get(day)
  const actions = useDayActions(day, group, busy, select)
  const dayRun = useDayRun(day, index.byDay, busy, select)
  const clearRun = dayRun.clear
  /** A plain click or arrow selects one day, and a run ends there. */
  const selectOne = useCallback(
    (d: DayKey) => {
      clearRun()
      select(d)
    },
    [clearRun, select],
  )
  const moveMode = useMoveMode(range, actions.moveTo)
  const dnd = useDayDrag(actions.moveTo)
  // What is on screen (QA 15): the move target while moving a photo, else the
  // selected day; the month zoom shows that day's month, so its year too.
  const moving = moveMode.move
  const viewDay = moving?.target ?? day
  const year = moving || daysZoom === 'month' ? yearOf(viewDay) : (daysYear ?? yearOf(day))
  const startMove = () => {
    if (busy) return
    clearRun()
    moveMode.start(group?.selectedId, day)
  }
  /** The toolbar stepper (by month in month zoom, else by year) and [ / ] (by year): moves the target while moving. */
  const stepView = (months: number) => {
    if (moving) moveMode.retarget(shiftMonthKeepDay(moving.target, months))
    else if (daysZoom === 'month') select(clampDay(shiftMonth(day, months), range))
    else setDaysYear(clampYear(year + months / MONTHS_PER_YEAR, index.years))
  }
  const stepYear = (delta: number) => stepView(delta * MONTHS_PER_YEAR)
  useDaysKeys({
    day,
    group,
    zoom: daysZoom,
    range,
    moving: moving !== null,
    select: selectOne,
    extend: dayRun.extend,
    endRun: dayRun.run ? clearRun : null,
    choose: actions.choose,
    // X applies to the run while there is one (critique round 6, P1-4).
    toggleExcluded: dayRun.run ? dayRun.toggle : actions.toggleExcluded,
    startMove,
    setZoom: setDaysZoom,
    stepYear,
  })

  const [render, setRender] = useState<RenderSettings | null>(null)
  // The print becomes the film (signature moment 3): the player opens on the selected day's
  // frame, so the View Transition grows that face cell into the same picture.
  const frames = useFrames(session?.frames.status === 'complete').data
  const framesByDay = useMemo(() => (frames ? new Map(frames.frames.map((f) => [f.dayKey, f])) : undefined), [frames])
  const openTimelapse = () => {
    const at = frames?.frames.findIndex((f) => f.dayKey === day) ?? -1
    if (at >= 0) usePlayer.getState().setIndex(at)
    useView.getState().setStep('timelapse')
  }
  const models = useModelsBlock()
  const alignFailed = useJobs((s) => (s.activeKind === 'align' ? null : s.align.error))
  const align = () => {
    if (session && !busy && !models) void startAlign(render ?? session.render).catch(reportError)
  }
  usePrimaryAction(session?.frames.status === 'complete' ? openTimelapse : align)

  const base = info?.imageBaseUrl ?? ''
  const pickYear = useCallback(
    (y: number) => {
      setDaysYear(y)
      setDaysZoom('year')
    },
    [setDaysYear, setDaysZoom],
  )
  // While moving a photo, every way of pointing at a day (a click, the ribbon,
  // Find a date, a Decade face, "Around it") retargets the move instead of
  // selecting, so Enter moves it where the user pointed (UI review 2, M6).
  const retarget = moveMode.retarget
  const isMoving = moving !== null
  const extendRun = dayRun.extend
  const pointAt = useCallback(
    (d: DayKey, extend = false) => {
      if (isMoving) retarget(d)
      else if (extend) extendRun(d)
      else selectOne(d)
    },
    [isMoving, retarget, extendRun, selectOne],
  )
  const pickDay = useCallback(
    (d: DayKey) => {
      pointAt(d)
      setDaysZoom('year')
    },
    [pointAt, setDaysZoom],
  )
  // What the ribbon marks as on screen (P1-3): the scrolled-into-view months in Year zoom, the month in Month zoom.
  const [yearSpan, setYearSpan] = useState<VisibleSpan | null>(null)
  const visibleSpan = daysZoom === 'year' ? yearSpan : daysZoom === 'month' ? monthSpan(viewDay) : null
  const dragSource = dnd.drag?.from ?? null
  const moveTarget = moveMode.move?.target ?? dnd.overDay
  const run = dayRun.run
  const view = useMemo<ViewProps>(
    () => ({ byDay: index.byDay, photos: photoMap, base, activeDay: day, activeFrame: framesByDay?.get(day), run, dragSource, moveTarget, range, onSelect: pointAt }),
    [index.byDay, photoMap, base, day, framesByDay, run, dragSource, moveTarget, range, pointAt],
  )
  const plan = dayRun.plan
  const runRow =
    run && plan
      ? {
          label: runLabel(run),
          days: runCount(run),
          action: runActionLabel(plan.excluded, plan.size),
          disabled: dayRun.applying || plan.changes.length === 0,
          onToggle: dayRun.toggle,
        }
      : null

  if (!session || !info || !days) return <Screen title={TITLE} subtitle={SUBTITLE}>{null}</Screen>
  return (
    <Screen
      title={TITLE}
      subtitle={SUBTITLE}
      center={<ZoomControls zoom={daysZoom} year={year} viewDay={viewDay} onZoom={setDaysZoom} onStep={(d) => (daysZoom === 'month' ? stepView(d) : stepYear(d))} />}
      tools={
        <DaysTools
          session={session}
          busy={busy}
          range={range}
          render={render ?? session.render}
          inspectorOpen={inspectorOpen}
          onToggleInspector={toggleInspector}
          onRender={setRender}
          onFind={pointAt}
          onAlign={align}
          onOpenTimelapse={openTimelapse}
        />
      }
      ribbon={<DaysRibbon index={index} sets={sets} photos={photoMap} base={base} year={year} day={viewDay} visibleSpan={run ?? visibleSpan} onSeek={pointAt} />}
    >
      <DndContext sensors={dnd.sensors} collisionDetection={dnd.collisionDetection} accessibility={DRAG_ACCESSIBILITY} {...dnd.handlers}>
        <div className="days">
          <DaysCanvas
            zoom={daysZoom}
            year={year}
            viewDay={viewDay}
            index={index}
            move={moving}
            view={view}
            alignError={alignFailed?.message ?? null}
            onPickYear={pickYear}
            onPickDay={pickDay}
            onSpan={setYearSpan}
          />
          {inspectorOpen ? (
            <DayInspector
              dayKey={day}
              group={group}
              photos={photoMap}
              byDay={index.byDay}
              frames={framesByDay}
              frameAspect={session?.reference ? `${session.reference.crop.width} / ${session.reference.crop.height}` : undefined}
              base={base}
              busy={busy}
              onChoose={actions.choose}
              onMove={(id, to) => actions.moveTo(id, day, to)}
              onStartMove={startMove}
              onToggleExcluded={actions.toggleExcluded}
              run={runRow}
              onAdd={actions.add}
              onSelectDay={pointAt}
            />
          ) : null}
        </div>
        <DragOverlay dropAnimation={dropSettle()}>
          <DragGhost photo={dnd.drag ? photoMap.get(dnd.drag.photoId) : undefined} base={base} from={dnd.drag?.from ?? null} overDay={dnd.overDay} />
        </DragOverlay>
      </DndContext>
    </Screen>
  )
}
