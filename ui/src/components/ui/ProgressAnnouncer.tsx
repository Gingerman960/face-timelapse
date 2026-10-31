import { useState } from 'react'

interface ProgressAnnouncerProps {
  /** Job phase ('running', 'done', 'failed'…); null while idle. A new phase is always spoken. */
  phase: string | null
  /** 0..1 while running; null when unknown. */
  fraction: number | null
  /** What to say if this update is spoken. */
  message: string
}

interface Spoken {
  phase: string | null
  step: number | null
  text: string
}

/**
 * One visually hidden, polite live region for a running job. Visual counters
 * update many times a second; this speaks only at the start, at each 10 %
 * step and at the end (DESIGN.md, Accessibility), so a screen reader isn't
 * flooded.
 */
export function ProgressAnnouncer({ phase, fraction, message }: ProgressAnnouncerProps) {
  const step = fraction === null ? null : Math.min(10, Math.floor(fraction * 10))
  const [spoken, setSpoken] = useState<Spoken>({ phase: null, step: null, text: '' })
  if (phase !== spoken.phase || (phase !== null && step !== null && step !== spoken.step)) {
    setSpoken({ phase, step, text: phase === null ? '' : message })
  }
  return (
    <p className="visually-hidden" role="status" aria-live="polite">
      {spoken.text}
    </p>
  )
}
