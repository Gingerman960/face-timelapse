import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
  title?: string
}

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: ReadonlyArray<SegmentOption<T>>
  onChange: (value: T) => void
  className?: string
}

/**
 * Index of the option that carries the tab stop: the checked one if it is
 * enabled, else the first enabled one, so the group is always reachable by Tab
 * even when `value` matches no option (e.g. a custom pace). -1 when all are disabled.
 */
function tabStopIndex<T extends string>(options: ReadonlyArray<SegmentOption<T>>, value: T): number {
  const checked = options.findIndex((o) => o.value === value && !o.disabled)
  return checked >= 0 ? checked : options.findIndex((o) => !o.disabled)
}

/** The enabled option an arrow, Home or End key moves to from enabled index `i` (-1: none checked). */
function nextIndex(key: string, i: number, count: number): number {
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  const back = key === 'ArrowLeft' || key === 'ArrowUp'
  if (i < 0) return back ? count - 1 : 0
  return back ? (i - 1 + count) % count : (i + 1) % count
}

const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']

/** A radio group drawn as a pill track; arrows move the selection (roving tabindex). */
export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const enabled = options.filter((o) => !o.disabled)
  const tabStop = tabStopIndex(options, value)

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!NAV_KEYS.includes(e.key)) return
    e.preventDefault()
    const target = enabled[nextIndex(e.key, enabled.findIndex((o) => o.value === value), enabled.length)]
    if (!target) return
    onChange(target.value)
    refs.current[options.indexOf(target)]?.focus()
  }

  return (
    <div role="radiogroup" aria-label={label} className={['segmented', className].filter(Boolean).join(' ')} onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === tabStop ? 0 : -1}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

interface ChipGroupProps<T extends string> extends SegmentedProps<T> {
  mono?: boolean
}

/** Radio chips (e.g. resolution presets); disabled chips carry their reason in `title`. */
export function ChipGroup<T extends string>({ label, value, options, onChange, className }: ChipGroupProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className={['chips', className].filter(Boolean).join(' ')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
