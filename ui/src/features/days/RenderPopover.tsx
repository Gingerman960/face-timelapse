import { useRef, useState } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import type { BackdropMode, RenderSettings, Resolution } from '../../ipc/contract'
import { PlateButton, QuietButton } from '../../components/ui/Button'
import { SwitchRow } from '../../components/ui/Controls'
import { Popover } from '../../components/ui/Overlays'
import { Segmented } from '../../components/ui/Segmented'

interface RenderPopoverProps {
  value: RenderSettings
  onChange: (value: RenderSettings) => void
  disabled: boolean
  /** Once frames exist: the popover also offers Align again. */
  onAlign?: () => void
}

const RESOLUTION_LABEL: Record<Resolution, string> = { '720p': '720p', '1080p': '1080p', '2160p': '4K', source: 'Source' }
const BACKDROP_LABEL: Record<BackdropMode, string> = { extended: 'Extend edges', dimmed: 'Dim', blurred: 'Blur', black: 'Black' }
const RESOLUTIONS: readonly Resolution[] = ['720p', '1080p', '2160p', 'source']
const BACKDROPS: readonly BackdropMode[] = ['extended', 'dimmed', 'blurred', 'black']

/** What fills the frame where a rotated or shifted photo doesn't reach. */
const BACKDROP_HELP: Record<BackdropMode, string> = {
  extended: 'The photo’s own edges, stretched and softly blurred. No visible seam.',
  dimmed: 'The photo itself, darkened, around the aligned frame.',
  blurred: 'The photo itself, blurred, around the aligned frame.',
  black: 'Plain black around the aligned frame.',
}

/** "1080p · Extend edges": the settings the next align will use. */
export function renderSummary(value: RenderSettings): string {
  return `${RESOLUTION_LABEL[value.resolution]} · ${BACKDROP_LABEL[value.backdrop]}`
}

/**
 * Alignment settings: output resolution, backdrop and landmark refinement.
 * The trigger is a quiet button that says what they are set to (P2-12), the
 * same before and after the first align; once frames exist the popover also
 * offers Align again.
 */
export function RenderPopover({ value, onChange, disabled, onAlign }: RenderPopoverProps) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const summary = renderSummary(value)
  const trigger = (
    <QuietButton
      ref={anchor}
      className="render-trigger"
      aria-label={`Alignment settings: ${summary}`}
      title="Alignment settings"
      aria-expanded={open}
      onClick={() => setOpen(true)}
      disabled={disabled}
    >
      {/* The chip names the size only; what fills the frame is explained inside, under "Outside the photo" (critique round 4). */}
      <span className="mono-values">{RESOLUTION_LABEL[value.resolution]}</span>
      <CaretDown className="icon" aria-hidden="true" />
    </QuietButton>
  )
  return (
    <>
      {trigger}
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} labelledBy="render-title" width={340}>
        <h3 id="render-title">Alignment</h3>
        <p>Frames are rendered once at this size; exports can be smaller, never larger.</p>
        <div className="render-row">
          <span className="render-label" aria-hidden="true">
            Frame size
          </span>
          <Segmented<Resolution>
            label="Frame size"
            value={value.resolution}
            onChange={(resolution) => onChange({ ...value, resolution })}
            options={RESOLUTIONS.map((r) => ({ value: r, label: RESOLUTION_LABEL[r] }))}
          />
        </div>
        <div className="render-row">
          <span className="render-label" aria-hidden="true">
            Outside the photo
          </span>
          <Segmented<BackdropMode>
            label="Outside the photo"
            value={value.backdrop}
            onChange={(backdrop) => onChange({ ...value, backdrop })}
            options={BACKDROPS.map((b) => ({ value: b, label: BACKDROP_LABEL[b] }))}
          />
          <p className="popover-help">{BACKDROP_HELP[value.backdrop]}</p>
        </div>
        <SwitchRow label="Refine landmarks" help="Re-detect each face at full size for a tighter fit" checked={value.refineLandmarks} onChange={(refineLandmarks) => onChange({ ...value, refineLandmarks })} />
        {onAlign ? (
          <div className="row end">
            <PlateButton
              onClick={() => {
                setOpen(false)
                onAlign()
              }}
            >
              Align again
            </PlateButton>
          </div>
        ) : null}
      </Popover>
    </>
  )
}
