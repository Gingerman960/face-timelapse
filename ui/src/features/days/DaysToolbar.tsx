import { useRef, useState } from 'react'
import { CaretLeft, CaretRight, MagnifyingGlass, Sidebar as SidebarIcon } from '@phosphor-icons/react'
import type { DayKey, RenderSettings, SessionSnapshot } from '../../ipc/contract'
import { IconButton, PlateButton } from '../../components/ui/Button'
import { Segmented } from '../../components/ui/Segmented'
import { useModelsBlock } from '../../state/models'
import type { DaysZoom } from '../../state/view'
import { alignPlateLabel } from './alignPlate'
import { FindDate } from './FindDate'
import { MONTH_NAMES, type DayRange } from './daysModel'
import { RenderPopover } from './RenderPopover'

const ZOOM_OPTIONS: ReadonlyArray<{ value: DaysZoom; label: string }> = [
  { value: 'decade', label: 'Decade' },
  { value: 'year', label: 'Year' },
  { value: 'month', label: 'Month' },
]

interface ZoomControlsProps {
  zoom: DaysZoom
  /** The year on screen. */
  year: number
  /** The day whose month the month zoom shows (the move target while moving a photo). */
  viewDay: DayKey
  onZoom: (zoom: DaysZoom) => void
  /** Previous (−1) or next (+1) year, or month in month zoom. */
  onStep: (delta: number) => void
}

/** "May 2014" for the month stepper. */
function monthLabel(day: DayKey): string {
  return `${MONTH_NAMES[Number(day.slice(5, 7)) - 1]?.slice(0, 3)} ${day.slice(0, 4)}`
}

/**
 * Zoom (Decade · Year · Month) and the year or month stepper. The stepper is
 * there in every zoom (in Decade it moves the current year) and its label has
 * a fixed width, so nothing in the toolbar centre shifts between zooms (QA 12).
 */
export function ZoomControls({ zoom, year, viewDay, onZoom, onStep }: ZoomControlsProps) {
  const monthly = zoom === 'month'
  const unit = monthly ? 'month' : 'year'
  return (
    <>
      <Segmented<DaysZoom> label="Zoom" value={zoom} onChange={onZoom} options={ZOOM_OPTIONS} />
      <div className="stepper days-nav" role="group" aria-label={monthly ? 'Month' : 'Year'}>
        <IconButton small label={`Previous ${unit}`} onClick={() => onStep(-1)}>
          <CaretLeft className="icon" aria-hidden="true" />
        </IconButton>
        <span className="stepper-value">{monthly ? monthLabel(viewDay) : year}</span>
        <IconButton small label={`Next ${unit}`} onClick={() => onStep(1)}>
          <CaretRight className="icon" aria-hidden="true" />
        </IconButton>
      </div>
    </>
  )
}

interface DaysToolsProps {
  session: SessionSnapshot
  busy: boolean
  range: DayRange
  render: RenderSettings
  inspectorOpen: boolean
  onToggleInspector: () => void
  onRender: (render: RenderSettings) => void
  onFind: (day: DayKey) => void
  onAlign: () => void
  onOpenTimelapse: () => void
}

function alignBlocker(busy: boolean, activeDays: number, models: string | null): string | undefined {
  if (busy) return 'Another task is running.'
  if (models) return models
  return activeDays === 0 ? 'No days to align.' : undefined
}

/**
 * Find a date, the inspector toggle (the shared `inspectorOpen`, as ⌥⌘I), the
 * alignment settings, and the plate: Align N days, Re-align the N days that
 * need it, or Open Timelapse once every frame exists.
 */
export function DaysTools({ session, busy, range, render, inspectorOpen, onToggleInspector, onRender, onFind, onAlign, onOpenTimelapse }: DaysToolsProps) {
  const [findOpen, setFindOpen] = useState(false)
  const findRef = useRef<HTMLButtonElement>(null)
  const active = session.counts.activeDays
  const status = session.frames.status
  const models = useModelsBlock()
  return (
    <>
      <IconButton ref={findRef} label="Find a date" aria-expanded={findOpen} onClick={() => setFindOpen(true)}>
        <MagnifyingGlass className="icon" aria-hidden="true" />
      </IconButton>
      <IconButton label="Toggle inspector" aria-pressed={inspectorOpen} onClick={onToggleInspector}>
        <SidebarIcon className="icon" aria-hidden="true" mirrored />
      </IconButton>
      <FindDate anchor={findRef} open={findOpen} onClose={() => setFindOpen(false)} onFind={onFind} range={range} />
      <RenderPopover value={render} onChange={onRender} disabled={busy} onAlign={status === 'complete' ? onAlign : undefined} />
      {status === 'complete' ? (
        <PlateButton kbd="⌘↩" onClick={onOpenTimelapse}>
          Open Timelapse
        </PlateButton>
      ) : (
        <PlateButton kbd="⌘↩" onClick={onAlign} disabled={busy || active === 0 || models !== null} title={alignBlocker(busy, active, models)}>
          {alignPlateLabel(session.frames, active)}
        </PlateButton>
      )}
    </>
  )
}
