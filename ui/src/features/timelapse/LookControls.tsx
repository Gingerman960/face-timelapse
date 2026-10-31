import { useCallback, useRef, useState } from 'react'
import { CaretDown, CircleHalf, StackSimple } from '@phosphor-icons/react'
import type { LookSettings } from '../../ipc/contract'
import { IconButton } from '../../components/ui/Button'
import { ToggleChip } from '../../components/ui/Controls'
import type { LookMode } from '../../state/player'
import { LookPopover, OnionPopover } from './TransportPopovers'
import { useOnion } from './useOnion'

interface LookControlsProps {
  disabled: boolean
  look: LookSettings
  /** Changes the look; a returned promise settles when the frames have the new look. */
  onLook: (look: LookSettings) => unknown
  /** The Even light mode switched on by the chip and the Strength slider. */
  lookMode: LookMode
}

type Menu = 'onion' | 'look' | null

/**
 * The Look pair in the plate caption (critique round 4, P1-2): Onion skin (O,
 * D, A) and Even light (N), each a toggle chip in the app's one pressed style
 * with its settings popover on a split caret.
 */
export function LookControls({ disabled, look, onLook, lookMode }: LookControlsProps) {
  const [onion, onOnion] = useOnion()
  const [menu, setMenu] = useState<Menu>(null)
  const close = useCallback(() => setMenu(null), [])
  const onionRef = useRef<HTMLButtonElement>(null)
  const lookRef = useRef<HTMLButtonElement>(null)
  const lookOn = look.normalize !== 'off'
  return (
    <div className="look-pair">
      <span className="split-chip" data-on={onion.on || undefined}>
        <ToggleChip
          pressed={onion.on}
          onPressedChange={(on) => onOnion({ on })}
          icon={<StackSimple className="icon" aria-hidden="true" />}
          kbd="O"
          title="Onion skin (O)"
          disabled={disabled}
        >
          <span className="chip-word">Onion</span>
        </ToggleChip>
        <IconButton ref={onionRef} className="split-caret" label="Onion skin settings" aria-expanded={menu === 'onion'} onClick={() => setMenu('onion')} disabled={disabled}>
          <CaretDown className="icon" aria-hidden="true" />
        </IconButton>
      </span>
      <OnionPopover anchor={onionRef} open={menu === 'onion'} onClose={close} onion={onion} onOnion={onOnion} />
      <span className="split-chip" data-on={lookOn || undefined}>
        <ToggleChip
          pressed={lookOn}
          onPressedChange={(on) => onLook({ ...look, normalize: on ? lookMode : 'off' })}
          icon={<CircleHalf className="icon" aria-hidden="true" />}
          kbd="N"
          title="Even out light (N)"
          disabled={disabled}
        >
          <span className="chip-word">Even light</span>
        </ToggleChip>
        <IconButton ref={lookRef} className="split-caret" label="Even light settings" aria-expanded={menu === 'look'} onClick={() => setMenu('look')} disabled={disabled}>
          <CaretDown className="icon" aria-hidden="true" />
        </IconButton>
      </span>
      <LookPopover anchor={lookRef} open={menu === 'look'} onClose={close} look={look} onLook={onLook} lookMode={lookMode} />
    </div>
  )
}
