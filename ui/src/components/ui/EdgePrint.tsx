interface EdgePrintProps {
  /** Frame number, printed as "▸ 0001". */
  n?: number
  /** Zero-padding of the frame number. */
  digits?: number
  /** The count of frames, printed after the number ("▸ 01 / 01"): a film of one carries its own counter. */
  total?: number
  /** Print the "▸" marker before the number (narrow strips keep it for the playhead frame only). */
  marker?: boolean
  /** Day key 'YYYY-MM-DD' (printed as 2014·08·15) or any short text. */
  day?: string
}

/**
 * Film edge print above a frame: decorative frame number and date.
 *
 * Drawn as CSS generated content (see `.edge` in base.css) so it never becomes
 * part of a control's visible text: the frame's aria-label carries the meaning,
 * and the label stays a match for what a speech-input user sees (WCAG 2.5.3).
 */
export function EdgePrint({ n, digits = 4, marker = true, total, day }: EdgePrintProps) {
  const counted = n === undefined ? undefined : String(n).padStart(digits, '0')
  const padded = counted === undefined || total === undefined ? counted : `${counted} / ${String(total).padStart(digits, '0')}`
  const num = padded === undefined ? undefined : marker ? `▸ ${padded}` : padded
  const text = day === undefined ? undefined : /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.replaceAll('-', '·') : day
  return <span className="edge" aria-hidden="true" data-n={num} data-day={text} />
}
