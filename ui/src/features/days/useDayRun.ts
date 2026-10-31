import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DayGroup, DayKey } from '../../ipc/contract'
import { reportError, setDaysExcluded } from '../../state/actions'
import { useView } from '../../state/view'
import { runChanges, runMessage, runOf, type DayExclusion, type DayRun, type RunPlan } from './dayRun'

export interface DayRunControls {
  run: DayRun | null
  /** What X would do to the run (null without one). */
  plan: RunPlan | null
  /** ⇧-click, ⇧←/⇧→, ⇧Space: the run reaches `day` from its anchor (the selected day when it starts) and `day` is selected. */
  extend: (day: DayKey) => void
  /** A plain click or arrow, Esc, a move: the run ends. */
  clear: () => void
  /** X on the run: leaves it out or puts it back, then one toast with one Undo. */
  toggle: () => void
  /** A run's changes are on their way: X and its row rest until they land. */
  applying: boolean
}

/**
 * A run of days on the Days screen (critique round 6, P1-4). X applies it as
 * one `set_day_excluded` after another (no bulk command is needed), never two
 * passes at once, and nothing starts while a job runs.
 */
export function useDayRun(day: DayKey, byDay: ReadonlyMap<DayKey, DayGroup>, busy: boolean, select: (day: DayKey) => void): DayRunControls {
  const [anchor, setAnchor] = useState<DayKey | null>(null)
  const [applying, setApplying] = useState(false)
  const inFlight = useRef(false)
  // The selected day as a ref, so `extend` stays one function and the calendar's cells don't re-render.
  const current = useRef(day)
  useEffect(() => {
    current.current = day
  })
  const run = useMemo(() => runOf(anchor, day), [anchor, day])
  const plan = useMemo(() => (run ? runChanges(run, byDay) : null), [run, byDay])

  const extend = useCallback(
    (to: DayKey) => {
      setAnchor((a) => a ?? current.current)
      select(to)
    },
    [select],
  )
  const clear = useCallback(() => setAnchor(null), [])

  const apply = useCallback((changes: DayExclusion[], done?: () => void) => {
    if (inFlight.current) return
    inFlight.current = true
    setApplying(true)
    void setDaysExcluded(changes)
      .then(done, reportError)
      .finally(() => {
        inFlight.current = false
        setApplying(false)
      })
  }, [])

  const toggle = () => {
    if (!plan || busy || plan.changes.length === 0) return
    const { changes, excluded } = plan
    const undo = changes.map((c) => ({ dayKey: c.dayKey, excluded: !c.excluded }))
    apply(changes, () =>
      useView.getState().pushToast({ message: runMessage(excluded, changes.length), tone: 'info', action: { label: 'Undo', run: () => apply(undo) } }),
    )
  }
  return { run, plan, extend, clear, toggle, applying }
}
