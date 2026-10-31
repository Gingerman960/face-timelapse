// The keyboard map as data for the Keys card (critique round 5, P2-13):
// DESIGN.md "Keyboard map" (ARCHITECTURE §8 with the P7 additions), only the
// keys the app answers today. Every screen has its own section, then the keys
// that work everywhere; each row says why you'd press it (Move · Decide ·
// Look · Make). A cap is written as macOS prints it, modifiers in ⌃ ⌥ ⇧ ⌘
// order (⇧⌘O); several caps on one row are alternatives.
import type { Step } from '../../lib/steps'

/** Why you press a key: the card's groups. */
export type KeyIntent = 'move' | 'decide' | 'look' | 'make'

/** The card's group order. */
export const INTENT_ORDER: readonly KeyIntent[] = ['move', 'decide', 'look', 'make']

const INTENT_LABEL: Readonly<Record<KeyIntent, string>> = { move: 'Move', decide: 'Decide', look: 'Look', make: 'Make' }

export interface KeyRow {
  readonly intent: KeyIntent
  /** One cap per entry; several are alternatives ("Y", "→", "↩"). A chord is one cap ("⇧⌘O"). */
  readonly keys: readonly string[]
  /** What it does, in words: sentence case, no full stop. */
  readonly does: string
}

export interface KeySection {
  /** The screen's name as the sidebar says it, or "Everywhere". */
  readonly title: string
  readonly rows: readonly KeyRow[]
  /** When the keys work, if not always (a sentence). */
  readonly note?: string
}

/** What the card describes: a screen, or the export sheet over the timelapse. */
export type KeyContext = Step | 'export'

export interface KeyGroup {
  readonly intent: KeyIntent
  readonly label: string
  readonly rows: readonly KeyRow[]
}

function row(intent: KeyIntent, keys: readonly string[], does: string): KeyRow {
  return { intent, keys, does }
}

const TIMELAPSE: KeySection = {
  title: 'Timelapse',
  rows: [
    row('move', ['←', '→'], 'Previous or next frame'),
    row('move', ['⇧←', '⇧→'], 'Back or ahead 10 frames'),
    row('move', ['⌥←', '⌥→'], 'Back or ahead a year'),
    row('move', ['Home', 'End'], 'First or last frame'),
    row('look', ['Space'], 'Play or pause'),
    row('look', ['J', 'K', 'L'], 'Play backward, pause, play forward; again to go faster'),
    row('look', ['O'], 'Onion skin on or off'),
    row('look', ['D'], 'Onion skin as a difference'),
    row('look', ['A'], 'Anchor points on or off'),
    row('look', ['N'], 'Even light on or off'),
    row('look', ['F'], 'Full-window viewer'),
    row('make', ['E', '⌘E'], 'Export the timelapse'),
  ],
}

/** Each screen's own keys (DESIGN keyboard map: setup, scan library, review, days, timelapse, export sheet). */
export const SCREEN_KEYS: Readonly<Record<KeyContext, KeySection>> = {
  setup: {
    title: 'Reference',
    rows: [
      row('decide', ['←', '→', '↑', '↓'], 'Nudge the crop 1 px, or 10 px with Shift'),
      row('decide', ['L'], 'Level the eyes'),
      row('decide', ['C'], 'Centre the face'),
      row('decide', ['R'], 'Reset the crop'),
    ],
  },
  scan: {
    title: 'Scan',
    rows: [
      row('move', ['←', '→'], 'Previous or next photo'),
      row('move', ['↑', '↓'], 'The row above or below'),
      row('move', ['Home', 'End'], 'First or last photo'),
      row('decide', ['↩', 'Space'], 'Select the photo, to keep it or leave it out'),
    ],
    note: 'These work in the photo sheet once the scan has finished.',
  },
  review: {
    title: 'Review',
    rows: [
      row('decide', ['Y', '→', '↩'], 'Keep the photo'),
      row('decide', ['N', '←', '⌫'], 'Leave it out'),
      row('decide', ['U', '⌘Z'], 'Undo the last call'),
      row('decide', ['⇧A'], 'Keep all remaining'),
      row('look', ['Space'], 'Hold to compare with the reference'),
    ],
  },
  days: {
    title: 'Days',
    rows: [
      row('move', ['←', '→'], 'Previous or next day'),
      row('move', ['[', ']'], 'Previous or next year'),
      row('move', ['⇧←', '⇧→'], 'Draw a run of days (or ⇧-click); Esc ends it'),
      row('decide', ['↑', '↓'], 'Pick the previous or next photo of the day'),
      row('decide', ['1–9'], 'Pick a photo by its number'),
      row('decide', ['X'], 'Leave the day or the run out, or put it back'),
      row('decide', ['M'], 'Move a photo to another day'),
      row('look', ['⌘↑', '⌘↓'], 'Zoom out or in'),
    ],
  },
  // Aligning shows the Timelapse screen with its keys at rest; only the job's own stop works.
  align: {
    title: 'Timelapse',
    rows: [row('make', ['⌘.'], 'Stop aligning; the frames done so far are kept')],
    note: 'The player’s keys work once the frames are aligned.',
  },
  timelapse: TIMELAPSE,
  export: {
    title: 'Export',
    rows: [
      row('move', ['Esc'], 'Close the sheet, except while encoding'),
      row('make', ['⌘↩'], 'Export, or play the saved video'),
      row('make', ['⌘.'], 'Stop encoding'),
    ],
  },
}

/** The keys every screen answers (DESIGN keyboard map, global row; ⌘, has no settings to open yet). */
export const EVERYWHERE: KeySection = {
  title: 'Everywhere',
  rows: [
    row('move', ['⌘1–⌘5'], 'Go to a stage, in the sidebar’s order'),
    row('move', ['Esc'], 'Close what is open, or cancel a drag'),
    row('look', ['⌃⌘S'], 'Show or hide the sidebar'),
    row('look', ['⌥⌘I'], 'Show or hide the inspector'),
    row('look', ['?'], 'Show or put away these keys'),
    row('look', ['⌘/'], 'Show these keys (Help › Keyboard Shortcuts)'),
    row('make', ['⌘↩'], 'Run the screen’s primary action'),
    row('make', ['⌘O'], 'Choose the reference photo'),
    row('make', ['⇧⌘O'], 'Choose the folder of daily photos'),
    row('make', ['⌘.'], 'Stop the running task'),
  ],
}

/**
 * The card's sections for what is on screen: its own keys first, then
 * Everywhere. A modal sheet lets only its own keys through (DESIGN: only
 * ⌘., Esc and its ⌘↩ reach past it), so over the export sheet there is no
 * Everywhere.
 */
export function keyMapFor(context: KeyContext): readonly KeySection[] {
  return context === 'export' ? [SCREEN_KEYS.export] : [SCREEN_KEYS[context], EVERYWHERE]
}

/** Rows grouped by intent in the card's order (Move · Decide · Look · Make); empty groups are left out. */
export function groupByIntent(rows: readonly KeyRow[]): KeyGroup[] {
  return INTENT_ORDER.map((intent) => ({ intent, label: INTENT_LABEL[intent], rows: rows.filter((r) => r.intent === intent) })).filter(
    (group) => group.rows.length > 0,
  )
}

/** Glyphs as the keys are called on a Mac (System Settings › Keyboard, VoiceOver). */
const GLYPH_WORDS: Readonly<Record<string, string>> = {
  '⌃': 'Control',
  '⌥': 'Option',
  '⇧': 'Shift',
  '⌘': 'Command',
  '←': 'Left arrow',
  '→': 'Right arrow',
  '↑': 'Up arrow',
  '↓': 'Down arrow',
  '↩': 'Return',
  '⌫': 'Delete',
  '[': 'Left bracket',
  ']': 'Right bracket',
  '?': 'Question mark',
  '.': 'Period',
  '/': 'Slash',
  ',': 'Comma',
  '–': 'to',
}

/** Caps written as a word that isn't the key's own name. */
const CAP_WORDS: Readonly<Record<string, string>> = { Esc: 'Escape' }

/** A cap in words, for screen readers: "⇧⌘O" → "Shift Command O", "1–9" → "1 to 9". */
export function spokenKey(cap: string): string {
  const word = CAP_WORDS[cap]
  if (word !== undefined) return word
  if (/^[A-Z][a-z]+$/.test(cap)) return cap
  return [...cap].map((ch) => GLYPH_WORDS[ch] ?? ch).join(' ')
}

/** A row's alternatives in words: "Y, Right arrow or Return". */
export function spokenKeys(keys: readonly string[]): string {
  const words = keys.map(spokenKey)
  const last = words.at(-1)
  if (last === undefined) return ''
  const rest = words.slice(0, -1)
  return rest.length === 0 ? last : `${rest.join(', ')} or ${last}`
}

type KeyMapKeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>

/**
 * The key that shows or puts away the card: "?" as typed (Shift is how it is
 * typed), never with ⌘, ⌃ or ⌥ (⌘? is the Help menu's search on a Mac).
 */
export function isKeyMapKey(e: KeyMapKeyEvent): boolean {
  return e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey
}
