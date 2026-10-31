import { useState, type FormEvent, type RefObject } from 'react'
import type { DayKey } from '../../ipc/contract'
import { isDayKey } from '../../lib/dates'
import { QuietButton } from '../../components/ui/Button'
import { Popover } from '../../components/ui/Overlays'
import type { DayRange } from './daysModel'

const POPOVER_WIDTH = 280

interface FindDateProps {
  anchor: RefObject<HTMLButtonElement | null>
  open: boolean
  onClose: () => void
  onFind: (day: DayKey) => void
  range: DayRange
}

/** "Go to a date": a YYYY-MM-DD field that accepts real calendar dates only. */
export function FindDate({ anchor, open, onClose, onFind, range }: FindDateProps) {
  const [value, setValue] = useState('')
  const valid = isDayKey(value)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    onFind(value)
    onClose()
  }
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} labelledBy="find-title" width={POPOVER_WIDTH}>
      <h3 id="find-title">Go to a date</h3>
      <form className="row" onSubmit={submit}>
        <label className="num" style={{ flex: 1 }}>
          <input
            aria-label="Date"
            placeholder={range.first ?? 'YYYY-MM-DD'}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            style={{ width: '100%', textAlign: 'left' }}
          />
        </label>
        <QuietButton type="submit" disabled={!valid}>
          Go
        </QuietButton>
      </form>
    </Popover>
  )
}
