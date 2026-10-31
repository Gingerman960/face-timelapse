import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Shortcut hint rendered as a key cap (decorative; the shortcut itself is global). */
  kbd?: string
  icon?: ReactNode
}

function cx(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(' ')
}

/** The one primary action of a screen: a reversed plate. */
export const PlateButton = forwardRef<HTMLButtonElement, ButtonProps & { wide?: boolean }>(function PlateButton(
  { kbd, icon, children, className, wide, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx('btn-plate', wide && 'wide', className)} {...rest}>
      {icon}
      {children}
      {kbd ? <kbd aria-hidden="true">{kbd}</kbd> : null}
    </button>
  )
})

/** Secondary action: a raised capsule. */
export const QuietButton = forwardRef<HTMLButtonElement, ButtonProps>(function QuietButton(
  { kbd, icon, children, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx('btn-quiet', className)} {...rest}>
      {icon}
      {children}
      {kbd ? <kbd aria-hidden="true">{kbd}</kbd> : null}
    </button>
  )
})

/** Destructive confirmation (stop red, always with words). */
export function StopButton({ kbd, icon, children, className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx('btn-stop', className)} {...rest}>
      {icon}
      {children}
      {kbd ? <kbd aria-hidden="true">{kbd}</kbd> : null}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name (also the tooltip). */
  label: string
  small?: boolean
}

/** Circular icon-only button; `label` names it for screen readers and the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, small, children, className, type = 'button', title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cx('btn-icon', small && 'sm', className)}
      {...rest}
    >
      {children}
    </button>
  )
})

/** Text-only action (underlined). */
export function TextButton({ children, className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={cx('btn-text', className)} {...rest}>
      {children}
    </button>
  )
}

export { cx }
