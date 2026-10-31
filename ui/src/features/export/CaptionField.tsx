import { useCallback, useRef, useState } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import type { CaptionOptions } from '../../ipc/contract'
import { CAPTION_FORMATS, strftime } from '../../lib/dates'
import { SwitchRow } from '../../components/ui/Controls'
import { Popover } from '../../components/ui/Overlays'
import { Segmented } from '../../components/ui/Segmented'
import { CAPTION_SIZES, POSITIONS } from './exportModel'

const DEFAULT_CAPTION: CaptionOptions = { position: 'bottomLeft', size: 0.04, format: '%-d %b %Y' }

interface CaptionFieldProps {
  caption: CaptionOptions | null
  sampleDay: string
  onChange: (c: CaptionOptions | null) => void
}

/** The 3×2 position picker. */
function PositionGrid({ caption, onChange }: { caption: CaptionOptions; onChange: (c: CaptionOptions) => void }) {
  return (
    <div className="pos-grid" role="radiogroup" aria-label="Caption position">
      {POSITIONS.map((p) => (
        <button
          key={p.value}
          type="button"
          role="radio"
          aria-checked={p.value === caption.position}
          aria-label={p.label}
          title={p.label}
          onClick={() => onChange({ ...caption, position: p.value })}
        />
      ))}
    </div>
  )
}

/** Caption on/off, position, date format and size. */
export function CaptionField({ caption, sampleDay, onChange }: CaptionFieldProps) {
  const [menu, setMenu] = useState<'format' | 'size' | null>(null)
  const close = useCallback(() => setMenu(null), [])
  const formatRef = useRef<HTMLButtonElement>(null)
  const sizeRef = useRef<HTMLButtonElement>(null)
  const current = caption ?? DEFAULT_CAPTION
  const sizeLabel = CAPTION_SIZES.find((s) => Math.abs(s.value - current.size) < 0.005)?.label ?? 'M'
  const pickSize = (label: string) => {
    const size = CAPTION_SIZES.find((x) => x.label === label)
    if (caption && size) onChange({ ...caption, size: size.value })
  }
  return (
    <div className="field stack">
      <span className="field-label">Caption</span>
      <SwitchRow label="Date caption" help="Each day gets its date, burned in" checked={caption !== null} onChange={(on) => onChange(on ? current : null)} />
      {caption ? (
        <div className="caption-opts">
          <PositionGrid caption={caption} onChange={onChange} />
          <button ref={formatRef} type="button" className="chip" aria-expanded={menu === 'format'} onClick={() => setMenu('format')}>
            {strftime(caption.format, sampleDay)}
            <CaretDown className="icon" aria-hidden="true" />
          </button>
          <Popover anchor={formatRef} open={menu === 'format'} onClose={close} labelledBy="fmt-title" width={260}>
            <h3 id="fmt-title">Date format</h3>
            <div className="menu-list" role="radiogroup" aria-label="Date format">
              {CAPTION_FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={f === caption.format}
                  onClick={() => {
                    onChange({ ...caption, format: f })
                    close()
                  }}
                >
                  <span>{strftime(f, sampleDay)}</span>
                  <span className="mono-meta">{f}</span>
                </button>
              ))}
            </div>
          </Popover>
          <button ref={sizeRef} type="button" className="chip" aria-expanded={menu === 'size'} onClick={() => setMenu('size')}>
            Size {sizeLabel}
            <CaretDown className="icon" aria-hidden="true" />
          </button>
          <Popover anchor={sizeRef} open={menu === 'size'} onClose={close} labelledBy="size-title" width={220}>
            <h3 id="size-title">Caption size</h3>
            <Segmented<string> label="Caption size" value={sizeLabel} onChange={pickSize} options={CAPTION_SIZES.map((s) => ({ value: s.label, label: s.label }))} />
          </Popover>
        </div>
      ) : null}
    </div>
  )
}
