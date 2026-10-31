import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

interface ToggleChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  icon?: ReactNode
  kbd?: string
}

/** A chip that stays pressed (the shared lit fill and ink ring) while on; `aria-pressed` mirrors the state. */
export function ToggleChip({ pressed, onPressedChange, icon, kbd, children, ...rest }: ToggleChipProps) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} onClick={() => onPressedChange(!pressed)} {...rest}>
      {icon}
      {children}
      {kbd ? <kbd aria-hidden="true">{kbd}</kbd> : null}
    </button>
  )
}

interface SwitchRowProps {
  label: string
  help?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

/** A labelled macOS-style switch backed by a real checkbox (`role="switch"`). */
export function SwitchRow({ label, help, checked, disabled, onChange }: SwitchRowProps) {
  const helpId = useId()
  return (
    <label className="switch-row">
      <span>
        {label}
        {help ? (
          <span className="field-help" id={helpId}>
            {help}
          </span>
        ) : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={help ? helpId : undefined}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <i aria-hidden="true" />
    </label>
  )
}

interface NumberFieldProps {
  label: string
  value: string
  unit: string
  invalid?: boolean
  disabled?: boolean
  width?: number
  /** Return `false` to reject the text: the field then snaps back to `value`. */
  onCommit: (raw: string) => boolean | void
}

/**
 * A compact numeric field in the data font. Edits are local until Enter or
 * blur, then `onCommit` receives the raw text. An accepted edit comes back as
 * the new `value` (possibly after an async round trip); a rejected one
 * (`onCommit` returns false) snaps back to the old value. Escape reverts an
 * unsaved edit (and only then reaches sheets and popovers).
 */
export function NumberField({ label, value, unit, invalid, disabled, width, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setDraft(value)
  }
  const commit = () => {
    if (onCommit(draft) === false) setDraft(value)
  }
  return (
    <label className="num" data-invalid={invalid ? 'true' : undefined}>
      <input
        aria-label={label}
        value={draft}
        inputMode="decimal"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        data-dirty={draft !== value ? 'true' : undefined}
        style={width ? { width } : undefined}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => draft !== value && commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Escape') setDraft(value)
          // ⌘↩ commits the field and then goes on to the sheet's own ⌘↩ (UI review 2, M5);
          // every other key belongs to the field.
          if (!(e.key === 'Enter' && (e.metaKey || e.ctrlKey))) e.stopPropagation()
        }}
      />
      <span aria-hidden="true">{unit}</span>
    </label>
  )
}

interface MeterProps {
  value: number
  label: string
  max?: number
  className?: string
}

/** A 2 px determinate progress bar (compositor-only: scaleX). */
export function Meter({ value, label, max = 1, className }: MeterProps) {
  const p = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  return (
    <div
      className={['meter', className].filter(Boolean).join(' ')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
    >
      <i style={{ ['--p' as string]: p }} />
    </div>
  )
}

interface FactsProps {
  rows: ReadonlyArray<{ label: string; value: ReactNode; mono?: boolean }>
  className?: string
}

/** A ruled key/value list (`dl`). */
export function Facts({ rows, className }: FactsProps) {
  return (
    <dl className={['facts', className].filter(Boolean).join(' ')}>
      {rows.map((r) => (
        <div key={r.label}>
          <dt>{r.label}</dt>
          <dd className={r.mono === false ? undefined : 'mono'}>{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}
